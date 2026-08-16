import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createAsrEngine, type AsrConfig, type AsrEngine, type AsrState } from './asr.ts'

/**
 * dsh-voice client half: voice playback surface + microphone input.
 *
 * - shell.overlay panel: SSE audio playback with caption + skip (barge-in).
 * - conversation.input.right mic button: RMS endpoint detection + local
 *   whisper transcription, filling the composer draft (optional auto-send).
 */

interface VoiceFrame {
  sessionId: string
  seq: number
  text: string
  audio: string
}

export interface VoicePanelActions {
  connect(): void
  skip(): void
  subscribe(fn: (s: AudioState) => void): () => void
}

export interface AudioState {
  connected: boolean
  playing: boolean
  caption: string | null
}

interface HostConfig {
  asr: AsrConfig
  basePath: string
}

export const inject = ['slots', 'sessions']

export function apply(ctx: any): void {
  // --- audio playback engine lives in the apply closure (object layer) ---
  const engine = createAudioEngine()

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'voice',
        order: 100,
        inject: (): VoicePanelActions => engine,
      },
      VoicePanel,
    ),
  )

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'voice-mic',
        order: 50,
        // Barge-in primitives: skipPlayback is always safe (silence TTS +
        // drop the host synthesis queue); cancelTurn is the stop-button
        // route and is only fired while the session has a running turn.
        inject: (sessionId): MicSlotActions => ({
          skipPlayback: () => {
            engine.skip()
            if (sessionId !== undefined) {
              void fetch('/dsh-voice-api/cancel', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId }),
              }).catch(() => {
                // cancel route unreachable: playback already skipped locally
              })
            }
          },
          cancelTurn: () => {
            if (sessionId === undefined) return
            void ctx.sessions
              .binding(sessionId)
              ?.session.cancel()
              .catch(() => {
                // turn cancel failure surfaces via promptError, not here
              })
          },
        }),
      },
      MicButton,
    ),
  )
}

function base64ToAudioUrl(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
}

function createAudioEngine(): VoicePanelActions {
  const listeners = new Set<(s: AudioState) => void>()
  let state: AudioState = { connected: false, playing: false, caption: null }
  const queue: VoiceFrame[] = []
  const audio = new Audio()
  let source: EventSource | null = null

  const notify = (): void => {
    for (const fn of listeners) fn(state)
  }

  const setState = (patch: Partial<AudioState>): void => {
    state = { ...state, ...patch }
    notify()
  }

  const playNext = (): void => {
    const frame = queue.shift()
    if (!frame) {
      setState({ playing: false, caption: null })
      return
    }
    const url = base64ToAudioUrl(frame.audio)
    audio.src = url
    audio.onended = () => {
      URL.revokeObjectURL(url)
      playNext()
    }
    audio.onerror = () => {
      URL.revokeObjectURL(url)
      playNext()
    }
    setState({ playing: true, caption: frame.text })
    void audio.play().catch(() => {
      setState({ playing: false })
    })
  }

  const connect = (): void => {
    if (source) return
    source = new EventSource('/dsh-voice-api/stream')
    source.onopen = () => setState({ connected: true })
    source.onerror = () => setState({ connected: false })
    source.addEventListener('audio', (e: MessageEvent<string>) => {
      const frame = JSON.parse(e.data) as VoiceFrame
      queue.push(frame)
      if (audio.paused) playNext()
    })
  }

  const skip = (): void => {
    queue.length = 0
    audio.pause()
    audio.onended = null
    audio.onerror = null
    setState({ playing: false, caption: null })
  }

  const subscribe = (fn: (s: AudioState) => void): (() => void) => {
    listeners.add(fn)
    fn(state)
    return () => {
      listeners.delete(fn)
    }
  }

  return { connect, skip, subscribe }
}

function VoicePanel(props: VoicePanelActions): React.ReactElement {
  const { connect, skip, subscribe } = props
  const [state, setState] = useState<AudioState>({
    connected: false,
    playing: false,
    caption: null,
  })

  useEffect(() => {
    connect()
    return subscribe(setState)
  }, [connect, subscribe])

  useStyle(UI_CSS)

  const playing = state.connected && state.playing
  const dot = playing ? '#2ea043' : state.connected ? '#8b949e' : '#f85149'

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        borderRadius: 999,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto',
        background: 'rgba(22, 24, 28, 0.85)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.4)',
        color: '#e6e8eb',
        maxWidth: 480,
        animation: 'dshv-fadein 0.25s ease',
      }}
    >
      {playing ? (
        <EqualizerBars color="#2ea043" height={13} />
      ) : (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dot,
            flexShrink: 0,
            transition: 'background 0.2s ease',
            ...(state.connected
              ? {}
              : ({
                  '--dshv-pulse': 'rgba(248, 81, 73, 0.45)',
                  animation: 'dshv-pulse 1.6s ease-out infinite',
                } as Record<string, unknown>)),
          }}
        />
      )}
      <span
        key={state.caption ?? 'idle'}
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          animation: 'dshv-fadein 0.2s ease',
        }}
      >
        {state.caption ?? (state.connected ? 'voice ready' : 'voice offline')}
      </span>
      {state.playing ? (
        <button
          className="dshv-skip"
          onClick={skip}
          style={{
            border: 'none',
            background: 'rgba(255, 255, 255, 0.14)',
            color: '#fff',
            borderRadius: 999,
            padding: '3px 12px',
            fontSize: 11,
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'background 0.15s ease',
          }}
        >
          skip
        </button>
      ) : null}
    </div>
  )
}

// --- microphone input ---

export interface MicSlotActions {
  /** Silence TTS playback and drop the host synthesis queue. Always safe. */
  skipPlayback(): void
  /** Stop the running turn (the stop-button cancel route). */
  cancelTurn(): void
}

interface MicProps extends MicSlotActions {
  useSession?: <T>(sel: (s: any) => T) => T
  useInput?: <T>(sel: (s: any) => T) => T
  inputActions?: {
    setDraft?: (text: string) => void
    submit?: () => void
  }
}

const STATE_LABEL: Record<AsrState, string> = {
  idle: 'voice: tap to speak',
  recording: 'voice: listening…',
  speech: 'voice: speaking…',
  transcribing: 'voice: transcribing…',
  'loading-model': 'voice: loading model…',
}

const STATE_COLOR: Record<AsrState, string> = {
  idle: '#8b949e',
  recording: '#f85149',
  speech: '#2ea043',
  transcribing: '#58a6ff',
  'loading-model': '#bc8cff',
}

// Shared keyframes + hover styles (GitHub-dark palette). Injected once.
const UI_CSS = `
@keyframes dshv-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes dshv-eq { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
@keyframes dshv-spin { to { transform: rotate(360deg) } }
@keyframes dshv-pulse {
  0% { box-shadow: 0 0 0 0 var(--dshv-pulse, rgba(248, 81, 73, 0.45)) }
  70% { box-shadow: 0 0 0 6px transparent }
  100% { box-shadow: 0 0 0 0 transparent }
}
.dshv-skip:hover { background: rgba(255, 255, 255, 0.26) !important }
.dshv-mic:hover { background: rgba(139, 148, 158, 0.14) !important }
`

let styleInjected = false

function useStyle(css: string): void {
  useEffect(() => {
    if (styleInjected) return
    styleInjected = true
    const el = document.createElement('style')
    el.textContent = css
    document.head.appendChild(el)
  }, [css])
}

/** Three bouncing bars, the classic "now speaking" visual. */
function EqualizerBars({ color, height = 12 }: { color: string; height?: number }): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height, flexShrink: 0 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: '100%',
            borderRadius: 99,
            background: color,
            transformOrigin: 'bottom',
            animation: `dshv-eq 0.85s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </span>
  )
}

function MicButton({ useSession, useInput, inputActions, skipPlayback, cancelTurn }: MicProps): React.ReactElement {
  const [asrState, setAsrState] = useState<AsrState>('idle')
  const [error, setError] = useState<string | null>(null)
  const engineRef = useRef<AsrEngine | null>(null)
  const configRef = useRef<AsrConfig | null>(null)
  const actionsRef = useRef(inputActions)
  const draftRef = useRef('')
  const runningRef = useRef(false)

  const draft = useInput ? useInput((s: any) => (s === undefined ? undefined : s.draft)) : undefined
  const running = useSession ? useSession((s: any) => (s === undefined ? undefined : s.running)) : undefined
  const bargeRef = useRef({ skipPlayback, cancelTurn })

  useEffect(() => {
    bargeRef.current = { skipPlayback, cancelTurn }
  }, [skipPlayback, cancelTurn])
  useEffect(() => {
    actionsRef.current = inputActions
  }, [inputActions])
  useEffect(() => {
    if (draft !== undefined) draftRef.current = String(draft ?? '')
  }, [draft])
  useEffect(() => {
    runningRef.current = running === true
  }, [running])

  // load ASR config from the host once
  useEffect(() => {
    let cancelled = false
    fetch('/dsh-voice-api/config')
      .then((r) => r.json() as Promise<HostConfig>)
      .then((c) => {
        if (cancelled) return
        configRef.current = c.asr
        const engine = createAsrEngine(c.asr, c.basePath)
        engine.onState(setAsrState)
        // Barge-in: the leading edge of user speech silences the assistant
        // (always), and stops the running turn when one exists (the stop
        // button route). The same speech then records normally.
        engine.onSpeechStart(() => {
          const { skipPlayback: skip, cancelTurn: cancel } = bargeRef.current
          skip()
          if (runningRef.current) cancel()
        })
        engine.onSegment((text) => {
          const actions = actionsRef.current
          if (!actions || typeof actions.setDraft !== 'function') return
          const trimmed = text.trim()
          if (!trimmed) return
          const current = draftRef.current
          const next = current.trim() === '' ? trimmed : current.replace(/\s+$/, '') + ' ' + trimmed
          actions.setDraft(next)
          if (c.asr.autoSend && typeof actions.submit === 'function') {
            setTimeout(() => {
              try {
                actions.submit?.()
              } catch {
                // ignore
              }
            }, 60)
          }
        })
        engineRef.current = engine
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
      void engineRef.current?.stop()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    if (error === null) return
    const t = setTimeout(() => setError(null), 4000)
    return () => clearTimeout(t)
  }, [error])

  const toggle = async (): Promise<void> => {
    const engine = engineRef.current
    if (!engine) return
    setError(null)
    try {
      if (engine.state === 'idle') {
        await engine.start()
      } else {
        await engine.stop()
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  const holdProps =
    configRef.current?.mode === 'hold'
      ? {
          onPointerDown: () => void engineRef.current?.start(),
          onPointerUp: () => void engineRef.current?.stop(),
        }
      : {}

  useStyle(UI_CSS)

  const busy = asrState === 'transcribing' || asrState === 'loading-model'
  const indicator = busy ? (
    // spinner ring while the host is recognizing / loading the model
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        border: '2px solid rgba(188, 140, 255, 0.25)',
        borderTopColor: STATE_COLOR[asrState],
        animation: 'dshv-spin 0.7s linear infinite',
        flexShrink: 0,
      }}
    />
  ) : asrState === 'speech' ? (
    <EqualizerBars color="#2ea043" height={11} />
  ) : (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: error ? '#f85149' : STATE_COLOR[asrState],
        display: 'inline-block',
        flexShrink: 0,
        transition: 'background 0.2s ease',
        ...(asrState === 'recording' && !error
          ? ({
              '--dshv-pulse': 'rgba(248, 81, 73, 0.45)',
              animation: 'dshv-pulse 1.2s ease-out infinite',
            } as Record<string, unknown>)
          : {}),
      }}
    />
  )

  const label = asrState === 'idle' ? 'mic' : error ?? STATE_LABEL[asrState].replace('voice: ', '')

  return (
    <button
      className="dshv-mic"
      onClick={toggle}
      {...holdProps}
      title={error ?? STATE_LABEL[asrState]}
      style={{
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        padding: '4px 8px',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        color: error ? '#f85149' : '#8b949e',
        transition: 'background 0.15s ease, color 0.2s ease',
      }}
    >
      {indicator}
      {label}
    </button>
  )
}
