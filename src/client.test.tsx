// @vitest-environment jsdom
/**
 * Client component tests for the voice UI.
 *
 * VoicePanel is pure (state arrives through the subscribe callback), so it is
 * driven with a fake audio-engine triple. MicButton owns the ASR engine, so
 * ./asr.ts is mocked and the host config fetch is stubbed — the assertions
 * cover the state indicators and the barge-in wiring, not the DSP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { AsrState } from './asr.ts'
import type { AudioState, VoicePanelActions } from './client.tsx'

// --- ASR engine mock: lets tests drive state/segment/speech-start edges ---

interface EngineHandles {
  emitState(state: AsrState): void
  emitSegment(text: string): void
  emitSpeechStart(): void
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

const engineHandles: { current: EngineHandles | null } = { current: null }

vi.mock('./asr.ts', () => ({
  createAsrEngine: () => {
    let onState: (s: AsrState) => void = () => {}
    let onSegment: (t: string) => void = () => {}
    let onSpeechStart: () => void = () => {}
    const start = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    engineHandles.current = {
      emitState: (s) => onState(s),
      emitSegment: (t) => onSegment(t),
      emitSpeechStart: () => onSpeechStart(),
      start,
      stop,
    }
    return {
      start,
      stop,
      onState: (fn: (s: AsrState) => void) => { onState = fn },
      onSegment: (fn: (t: string) => void) => { onSegment = fn },
      onSpeechStart: (fn: () => void) => { onSpeechStart = fn },
      skip: vi.fn(),
    }
  },
}))

const { VoicePanel, MicButton } = await import('./client.tsx')

/** Fake audio engine: `push` drives the panel through subscribe(). */
function fakeAudioEngine(): VoicePanelActions & {
  push(next: AudioState): void
  connect: ReturnType<typeof vi.fn>
  skip: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<(s: AudioState) => void>()
  let state: AudioState = { connected: false, playing: false, caption: null }
  return {
    connect: vi.fn(),
    skip: vi.fn(),
    subscribe(fn: (s: AudioState) => void) {
      listeners.add(fn)
      fn(state)
      return () => listeners.delete(fn)
    },
    push(next: AudioState) {
      state = next
      act(() => { listeners.forEach((fn) => fn(next)) })
    },
  }
}

const hostConfig = {
  asr: { mode: 'toggle' as const, autoSend: false },
  basePath: '/dsh-voice-api',
}

beforeEach(() => {
  engineHandles.current = null
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => hostConfig,
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('VoicePanel', () => {
  it('connects on mount and shows the offline caption before the stream opens', () => {
    const engine = fakeAudioEngine()
    render(<VoicePanel {...engine} />)
    expect(engine.connect).toHaveBeenCalledOnce()
    expect(screen.getByText('voice offline')).toBeTruthy()
  })

  it('switches to the ready caption once connected', () => {
    const engine = fakeAudioEngine()
    render(<VoicePanel {...engine} />)
    engine.push({ connected: true, playing: false, caption: null })
    expect(screen.getByText('voice ready')).toBeTruthy()
  })

  it('renders the live caption and a working skip button while playing', () => {
    const engine = fakeAudioEngine()
    render(<VoicePanel {...engine} />)
    engine.push({ connected: true, playing: true, caption: '你好，我是助手' })
    expect(screen.getByText('你好，我是助手')).toBeTruthy()
    const skip = screen.getByText('skip')
    fireEvent.click(skip)
    expect(engine.skip).toHaveBeenCalledOnce()
  })

  it('hides the skip button when playback is idle', () => {
    const engine = fakeAudioEngine()
    render(<VoicePanel {...engine} />)
    engine.push({ connected: true, playing: false, caption: 'done' })
    expect(screen.queryByText('skip')).toBeNull()
  })
})

describe('MicButton', () => {
  const noopBarge = { skipPlayback: vi.fn(), cancelTurn: vi.fn() }

  it('loads the host ASR config and starts idle', async () => {
    render(<MicButton {...noopBarge} />)
    expect(screen.getByText('mic')).toBeTruthy()
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    expect(fetch).toHaveBeenCalledWith('/dsh-voice-api/config')
  })

  it('reflects the engine state in the label', async () => {
    render(<MicButton {...noopBarge} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitState('recording'))
    expect(screen.getByText('listening…')).toBeTruthy()
    act(() => engineHandles.current!.emitState('transcribing'))
    expect(screen.getByText('transcribing…')).toBeTruthy()
    act(() => engineHandles.current!.emitState('loading-model'))
    expect(screen.getByText('loading model…')).toBeTruthy()
  })

  it('silences playback on the leading edge of speech (barge-in)', async () => {
    const skipPlayback = vi.fn()
    const cancelTurn = vi.fn()
    render(<MicButton skipPlayback={skipPlayback} cancelTurn={cancelTurn} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSpeechStart())
    expect(skipPlayback).toHaveBeenCalledOnce()
    // no running turn -> the stop-button route must stay untouched
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('also cancels the running turn when one is in flight', async () => {
    const skipPlayback = vi.fn()
    const cancelTurn = vi.fn()
    render(
      <MicButton
        skipPlayback={skipPlayback}
        cancelTurn={cancelTurn}
        useSession={(sel) => sel({ running: true })}
      />,
    )
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSpeechStart())
    expect(skipPlayback).toHaveBeenCalledOnce()
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('appends transcripts to the composer draft', async () => {
    const setDraft = vi.fn()
    render(
      <MicButton
        {...noopBarge}
        inputActions={{ setDraft }}
        useInput={(sel) => sel({ draft: '已有内容' })}
      />,
    )
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSegment('  新增语音  '))
    expect(setDraft).toHaveBeenCalledWith('已有内容 新增语音')
  })

  it('sets the draft verbatim when the composer is empty', async () => {
    const setDraft = vi.fn()
    render(<MicButton {...noopBarge} inputActions={{ setDraft }} useInput={(sel) => sel({ draft: '' })} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSegment('第一句'))
    expect(setDraft).toHaveBeenCalledWith('第一句')
  })

  it('ignores blank transcripts', async () => {
    const setDraft = vi.fn()
    render(<MicButton {...noopBarge} inputActions={{ setDraft }} useInput={(sel) => sel({ draft: '' })} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSegment('   '))
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('surfaces a host config failure on the button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<MicButton {...noopBarge} />)
    // short label in the composer, full message in the tooltip
    await waitFor(() => expect(screen.getByText('voice error')).toBeTruthy())
    expect(screen.getByTitle(/offline/)).toBeTruthy()
  })
})
