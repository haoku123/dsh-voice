/**
 * dsh-voice ASR engine (browser half): RMS-based endpoint detection on
 * getUserMedia audio + local whisper transcription loaded on demand from a
 * CDN ESM bundle (native dynamic import, no esbuild rewriting).
 */

export type AsrState = 'idle' | 'recording' | 'speech' | 'transcribing' | 'loading-model'

export interface AsrConfig {
  /** Whisper model id (onnx-community family, quantized). */
  model: string
  /** Model host, e.g. https://huggingface.co or https://hf-mirror.com (CN). */
  modelHost: string
  /** CDN base for the transformers.js ESM bundle. */
  cdnBase: string
  /** Whisper language hint: 'zh', 'en', or 'auto'. */
  language: string
  /** Interaction mode: toggle (tap to start/stop, auto-segments) or hold. */
  mode: 'toggle' | 'hold'
}

export interface AsrEngine {
  readonly state: AsrState
  start(): Promise<void>
  stop(): Promise<void>
  /** Fire on segment (start/stop is handled by the recorder). */
  readonly onSegment: (fn: (text: string) => void) => () => void
  readonly onState: (fn: (s: AsrState) => void) => () => void
  /** Fire at the leading edge of detected speech (the barge-in trigger). */
  readonly onSpeechStart: (fn: () => void) => () => void
  readonly setTranscriptHandler: (fn: (text: string) => void) => void
}

interface WhisperBundle {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Transcriber>
  env: { remoteHost: string }
}

interface Transcriber {
  (audio: Float32Array, opts?: Record<string, unknown>): Promise<{ text: string }>
}

const SAMPLE_RATE = 16000
const ENERGY_THRESHOLD = 0.015
const SILENCE_TIMEOUT_MS = 1300
const MAX_SEGMENT_MS = 30000
const PRE_PAD_MS = 250
const POST_PAD_MS = 350
// ScriptProcessor buffer size must be 0 or a power of two in [256, 16384].
// 1024 samples @ 16kHz = 64ms per onaudioprocess tick.
const BUFFER_SIZE = 1024

export function createAsrEngine(config: AsrConfig): AsrEngine {
  let state: AsrState = 'idle'
  const stateListeners = new Set<(s: AsrState) => void>()
  const transcriptListeners = new Set<(text: string) => void>()
  const speechStartListeners = new Set<() => void>()
  let transcriber: Transcriber | null = null
  let transcribing = false

  // --- recorder fields ---
  let audioCtx: AudioContext | null = null
  let stream: MediaStream | null = null
  let processor: ScriptProcessorNode | null = null
  let active = false
  let speechActive = false
  let segment: Float32Array[] = []
  let prePad: Float32Array[] = []
  let silenceMs = 0
  let segmentMs = 0
  let inFlush = false

  const setState = (s: AsrState): void => {
    state = s
    for (const fn of stateListeners) {
      try {
        fn(s)
      } catch {
        // listener errors must not kill the recorder
      }
    }
  }

  const emitTranscript = (text: string): void => {
    const t = text.trim()
    if (!t) return
    for (const fn of transcriptListeners) {
      try {
        fn(t)
      } catch {
        // ignore
      }
    }
  }

  const loadWhisper = async (): Promise<Transcriber> => {
    if (transcriber) return transcriber
    setState('loading-model')
    try {
      const mod = (await import(
        /* webpackIgnore: true */ `${config.cdnBase}/dist/transformers.web.js`
      )) as WhisperBundle
      mod.env.remoteHost = config.modelHost
      transcriber = await mod.pipeline('automatic-speech-recognition', config.model, { dtype: 'q8' })
      return transcriber
    } catch (e) {
      setState('idle')
      throw new Error(`whisper load failed: ${String(e)}`)
    }
  }

  const transcribeSegment = async (audio: Float32Array): Promise<void> => {
    if (transcribing) return
    transcribing = true
    setState('transcribing')
    try {
      const t = await loadWhisper()
      const lang = config.language === 'auto' ? undefined : config.language
      const out = await t(audio, lang ? { language: lang, task: 'transcribe' } : { task: 'transcribe' })
      emitTranscript(out.text)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[dsh-voice] transcription failed: ${String(e)}`)
    } finally {
      transcribing = false
      setState(active ? (speechActive ? 'speech' : 'recording') : 'idle')
    }
  }

  const finalizeSegment = (): void => {
    if (segment.length === 0) return
    const samples = new Float32Array(
      segment.reduce((n, c) => n + c.length, 0),
    )
    let off = 0
    for (const c of segment) {
      samples.set(c, off)
      off += c.length
    }
    segment = []
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    void transcribeSegment(samples)
  }

  const flushWithPad = (): void => {
    const padSamples = Math.floor((POST_PAD_MS / 1000) * SAMPLE_RATE)
    if (padSamples > 0) segment.push(new Float32Array(padSamples))
    finalizeSegment()
  }

  const handleAudio = (data: Float32Array): void => {
    if (!active || inFlush) return
    // RMS energy over this buffer
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    const durationMs = (data.length / SAMPLE_RATE) * 1000

    if (rms > ENERGY_THRESHOLD) {
      if (!speechActive) {
        speechActive = true
        setState('speech')
        for (const fn of speechStartListeners) {
          try {
            fn()
          } catch {
            // listener errors must not kill the recorder
          }
        }
        for (const p of prePad) segment.push(p)
        prePad = []
      }
      segmentMs += durationMs
      silenceMs = 0
      segment.push(data)
      if (segmentMs > MAX_SEGMENT_MS) flushWithPad()
    } else if (speechActive) {
      segmentMs += durationMs
      silenceMs += durationMs
      segment.push(data)
      if (silenceMs > SILENCE_TIMEOUT_MS) flushWithPad()
    } else {
      prePad.push(data)
      const keepMs = PRE_PAD_MS
      let total = 0
      let cut = 0
      for (let i = prePad.length - 1; i >= 0; i--) {
        total += (prePad[i].length / SAMPLE_RATE) * 1000
        if (total > keepMs) {
          cut = i + 1
          break
        }
      }
      if (cut > 0) prePad = prePad.slice(cut)
    }
  }

  const startRecorder = async (): Promise<void> => {
    if (active) return
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
    const source = audioCtx.createMediaStreamSource(stream)
    processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      handleAudio(new Float32Array(input))
    }
    source.connect(processor)
    processor.connect(audioCtx.destination)
    active = true
  }

  const stopRecorder = async (): Promise<void> => {
    if (!active) return
    active = false
    inFlush = true
    try {
      if (speechActive) {
        // trailing silence pad then finalize
        const padSamples = Math.floor((POST_PAD_MS / 1000) * SAMPLE_RATE)
        segment.push(new Float32Array(padSamples))
        finalizeSegment()
      } else {
        segment = []
      }
      prePad = []
    } finally {
      inFlush = false
    }
    try {
      processor?.disconnect()
    } catch {
      // ignore
    }
    processor = null
    try {
      void stream?.getTracks().forEach((t) => t.stop())
    } catch {
      // ignore
    }
    stream = null
    try {
      await audioCtx?.close()
    } catch {
      // ignore
    }
    audioCtx = null
  }

  return {
    get state() {
      return state
    },
    async start() {
      if (active) return
      setState('recording')
      await startRecorder()
    },
    async stop() {
      if (!active) {
        setState('idle')
        return
      }
      await stopRecorder()
      if (!transcribing) setState('idle')
    },
    onSegment(fn) {
      transcriptListeners.add(fn)
      return () => {
        transcriptListeners.delete(fn)
      }
    },
    onState(fn) {
      stateListeners.add(fn)
      fn(state)
      return () => {
        stateListeners.delete(fn)
      }
    },
    onSpeechStart(fn) {
      speechStartListeners.add(fn)
      return () => {
        speechStartListeners.delete(fn)
      }
    },
    setTranscriptHandler(fn) {
      transcriptListeners.clear()
      transcriptListeners.add(fn)
    },
  }
}
