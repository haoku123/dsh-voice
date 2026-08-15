import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: chunk/options shapes for the llm/stream waterfall tap.
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ServerResponse } from 'node:http'

import { SentenceSegmenter } from './segmenter.ts'
import { TtsQueue, type VoiceFrame } from './tts-queue.ts'

/**
 * dsh-voice host half: llm/stream tap -> sentence segmentation -> TTS queue
 * -> SSE broadcast to browser clients.
 */
export const name = 'voice'

export const inject = ['webServer']

/** Plugin config. */
export interface AsrRuntimeConfig {
  model: string
  modelHost: string
  cdnBase: string
  language: string
  autoSend: boolean
  mode: 'toggle' | 'hold'
}

export interface Config {
  basePath: string
  voice: string
  enabled: boolean
  asr: AsrRuntimeConfig
}

export const Config: z<Config> = z.object({
  basePath: z.string().default('/dsh-voice-api'),
  voice: z.string().default('zh-CN-XiaoxiaoNeural'),
  enabled: z.boolean().default(true),
  asr: z
    .object({
      model: z.string().default('onnx-community/whisper-base'),
      modelHost: z.string().default('https://huggingface.co'),
      cdnBase: z
        .string()
        .default('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0'),
      language: z.string().default('zh'),
      autoSend: z.boolean().default(false),
      mode: z.union([z.const('toggle'), z.const('hold')]).default('toggle'),
    })
    .default({}),
})

export function apply(ctx: Context, config: Config): void {
  const base = config.basePath

  // --- SSE fan-out: every client connection receives every voice frame. ---
  const clients = new Set<(frame: VoiceFrame) => void>()
  const queue = new TtsQueue({ voice: config.voice })
  const unsubscribe = queue.subscribe((frame) => {
    for (const send of clients) {
      try {
        send(frame)
      } catch {
        // dead socket: the close handler removes it
      }
    }
  })
  ctx.effect(() => unsubscribe)

  // --- llm/stream lossless tap: segment and enqueue, never block the model. ---
  const sessionSegmenters = new Map<string, SentenceSegmenter>()
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    if (!config.enabled || sessionId === undefined) return next()
    return tapStream(sessionId, next(), queue, sessionSegmenters)
  })

  // --- HTTP surface: SSE stream, cancel, and the wiring ping. ---
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/stream`,
      handler: (req, res: ServerResponse) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        const send = (frame: VoiceFrame): void => {
          res.write(`event: audio\ndata: ${JSON.stringify(frame)}\n\n`)
        }
        clients.add(send)
        const heartbeat = setInterval(() => {
          res.write(': hb\n')
        }, 25000)
        const cleanup = (): void => {
          clearInterval(heartbeat)
          clients.delete(send)
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/cancel`,
      handler: (req, res) => {
        let body = ''
        req.on('data', (c) => {
          body += c
        })
        req.on('end', () => {
          let sessionId: string | undefined
          try {
            sessionId = JSON.parse(body || '{}').sessionId
          } catch {
            // ignore malformed body
          }
          if (sessionId) queue.cancel(sessionId)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/config`,
      handler: (_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ asr: config.asr }))
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: (_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, name: 'dsh-voice', enabled: config.enabled }))
      },
    }),
  )
}

/**
 * Lossless passthrough tap: every chunk is yielded unchanged; text deltas
 * additionally feed the session's sentence segmenter and TTS queue.
 */
async function* tapStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: TtsQueue,
  sessionSegmenters: Map<string, SentenceSegmenter>,
): AsyncIterable<StreamChunk> {
  const segmenter = new SentenceSegmenter()
  sessionSegmenters.set(sessionId, segmenter)
  let flushed = false
  let finishReason: unknown = null
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const s of segmenter.flush()) queue.enqueue(sessionId, s)
  }
  try {
    for await (const chunk of inner) {
      if (chunk.type === 'text-delta' && chunk.text) {
        for (const s of segmenter.feed(chunk.text)) queue.enqueue(sessionId, s)
      }
      if (chunk.type === 'finish') finishReason = chunk.reason
      yield chunk
    }
  } finally {
    // A barge-in aborts the turn: the trailing half-sentence is exactly what
    // the user interrupted, so it must not be spoken.
    const aborted =
      finishReason !== null &&
      typeof finishReason === 'object' &&
      (finishReason as { kind?: unknown }).kind === 'aborted'
    if (!aborted) flushOnce()
    sessionSegmenters.delete(sessionId)
  }
}
