// Integration test for the host half: drive apply() with a stub ctx,
// capture the llm/stream listener, feed a mock chunk stream, and verify:
// 1. chunks pass through losslessly
// 2. sentences reach the TTS queue and are broadcast as voice frames
// 3. the SSE/cancel/ping routes register
import { apply, Config } from '../lib/index.js'

// --- stub ctx ---
const listeners = new Map()
const routes = []
const effects = []
let disposed = false

const ctx = {
  on(name, fn) {
    listeners.set(name, fn)
  },
  effect(fn) {
    effects.push(fn)
    const r = fn()
    return r ?? (() => {})
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

// --- drive apply ---
const config = {
  basePath: '/dsh-voice-api',
  voice: 'zh-CN-XiaoxiaoNeural',
  enabled: true,
  asr: {
    model: 'onnx-community/whisper-base',
    modelHost: 'https://huggingface.co',
    cdnBase: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0',
    language: 'zh',
    autoSend: false,
    mode: 'toggle',
  },
}
apply(ctx, config)

// routes registered?
const kinds = routes.map((r) => `${r.kind}:${r.path}`)
console.log('routes:', kinds.join(', '))
if (!routes.some((r) => r.path === '/dsh-voice-api/stream')) throw new Error('SSE route missing')
if (!routes.some((r) => r.path === '/dsh-voice-api/cancel')) throw new Error('cancel route missing')
if (!routes.some((r) => r.path === '/dsh-voice-api/config')) throw new Error('config route missing')
console.log('  ok  routes registered')

// /config returns the ASR runtime config
{
  const cfgRoute = routes.find((r) => r.path === '/dsh-voice-api/config')
  let body = ''
  const cfgRes = {
    statusCode: 200,
    setHeader() {},
    end(s) {
      body = s
    },
  }
  cfgRoute.handler({}, cfgRes)
  const parsed = JSON.parse(body)
  if (!parsed.asr || parsed.asr.model !== 'onnx-community/whisper-base') {
    throw new Error('config route missing asr payload: ' + body)
  }
  console.log('  ok  /config returns asr:', parsed.asr.model, '| host:', parsed.asr.modelHost)
}

// capture llm/stream listener
const llmStream = listeners.get('llm/stream')
if (typeof llmStream !== 'function') throw new Error('llm/stream listener missing')
console.log('  ok  llm/stream listener captured')

// collect broadcast frames by attaching a fake SSE client through the queue
// (the queue subscribes internally; we reach the fan-out by opening the SSE
// route handler with a mock response object)
const frames = []
const res = {
  writeHead() {},
  write(s) {
    if (s.startsWith('event: audio')) {
      const dataLine = s.split('\n').find((l) => l.startsWith('data: '))
      if (dataLine) frames.push(JSON.parse(dataLine.slice(6)))
    }
  },
  on() {},
  end() {},
}
const req = { on() {} }
const sseRoute = routes.find((r) => r.path === '/dsh-voice-api/stream')
sseRoute.handler(req, res)
console.log('  ok  SSE handler opened')

// --- mock llm stream ---
async function* mockStream() {
  yield { type: 'text-delta', index: 0, text: '这是第一句' }
  yield { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read_file', argumentsDelta: '{}' }
  yield { type: 'text-delta', index: 0, text: '说完。这是第二句。' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const options = { provider: 'test', model: 'test', messages: [], sessionId: 'sess-1' }
const wrapped = llmStream(options, mockStream)

// consume the wrapped stream; chunks must pass through unchanged
const seen = []
for await (const chunk of wrapped) seen.push(chunk)
if (seen.length !== 4) throw new Error(`expected 4 chunks, got ${seen.length}`)
if (seen[1].type !== 'tool-call-delta') throw new Error('tool-call chunk corrupted')
console.log('  ok  passthrough lossless (' + seen.length + ' chunks)')

// wait for the TTS pump to synthesize and broadcast (2 complete sentences)
const deadline = Date.now() + 30000
while (frames.length < 2 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 300))
}
console.log('  broadcast frames:', frames.length)
for (const f of frames) {
  console.log(`    [${f.sessionId} #${f.seq}] ${f.text} | audio=${f.audio.length}b b64`)
}
if (frames.length < 2) throw new Error(`expected 2 voice frames, got ${frames.length}`)
if (frames.some((f) => f.sessionId !== 'sess-1')) throw new Error('wrong sessionId on frame')
if (frames[0].text !== '这是第一句说完。') throw new Error('first sentence wrong: ' + frames[0].text)
if (!frames.every((f) => f.audio && f.audio.length > 100)) throw new Error('audio payload missing')

console.log('\nALL HOST INTEGRATION TESTS PASSED')
process.exit(0)
