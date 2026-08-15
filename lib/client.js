window.__ModuleLoader__.load({ id: "@haoku123/dsh-voice", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/asr.ts
var SAMPLE_RATE = 16e3;
var ENERGY_THRESHOLD = 0.015;
var SILENCE_TIMEOUT_MS = 1300;
var MAX_SEGMENT_MS = 3e4;
var PRE_PAD_MS = 250;
var POST_PAD_MS = 350;
var BUFFER_MS = 100;
function createAsrEngine(config) {
  let state = "idle";
  const stateListeners = /* @__PURE__ */ new Set();
  const transcriptListeners = /* @__PURE__ */ new Set();
  const speechStartListeners = /* @__PURE__ */ new Set();
  let transcriber = null;
  let transcribing = false;
  let audioCtx = null;
  let stream = null;
  let processor = null;
  let active = false;
  let speechActive = false;
  let segment = [];
  let prePad = [];
  let silenceMs = 0;
  let segmentMs = 0;
  let inFlush = false;
  const setState = (s) => {
    state = s;
    for (const fn of stateListeners) {
      try {
        fn(s);
      } catch {
      }
    }
  };
  const emitTranscript = (text) => {
    const t = text.trim();
    if (!t) return;
    for (const fn of transcriptListeners) {
      try {
        fn(t);
      } catch {
      }
    }
  };
  const loadWhisper = async () => {
    if (transcriber) return transcriber;
    setState("loading-model");
    try {
      const mod = await import(
        /* webpackIgnore: true */
        `${config.cdnBase}/dist/transformers.web.js`
      );
      mod.env.remoteHost = config.modelHost;
      transcriber = await mod.pipeline("automatic-speech-recognition", config.model, { dtype: "q8" });
      return transcriber;
    } catch (e) {
      setState("idle");
      throw new Error(`whisper load failed: ${String(e)}`);
    }
  };
  const transcribeSegment = async (audio) => {
    if (transcribing) return;
    transcribing = true;
    setState("transcribing");
    try {
      const t = await loadWhisper();
      const lang = config.language === "auto" ? void 0 : config.language;
      const out = await t(audio, lang ? { language: lang, task: "transcribe" } : { task: "transcribe" });
      emitTranscript(out.text);
    } catch (e) {
      console.warn(`[dsh-voice] transcription failed: ${String(e)}`);
    } finally {
      transcribing = false;
      setState(active ? speechActive ? "speech" : "recording" : "idle");
    }
  };
  const finalizeSegment = () => {
    if (segment.length === 0) return;
    const samples = new Float32Array(
      segment.reduce((n, c) => n + c.length, 0)
    );
    let off = 0;
    for (const c of segment) {
      samples.set(c, off);
      off += c.length;
    }
    segment = [];
    speechActive = false;
    silenceMs = 0;
    segmentMs = 0;
    void transcribeSegment(samples);
  };
  const flushWithPad = () => {
    const padSamples = Math.floor(POST_PAD_MS / 1e3 * SAMPLE_RATE);
    if (padSamples > 0) segment.push(new Float32Array(padSamples));
    finalizeSegment();
  };
  const handleAudio = (data) => {
    if (!active || inFlush) return;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const durationMs = data.length / SAMPLE_RATE * 1e3;
    if (rms > ENERGY_THRESHOLD) {
      if (!speechActive) {
        speechActive = true;
        setState("speech");
        for (const fn of speechStartListeners) {
          try {
            fn();
          } catch {
          }
        }
        for (const p of prePad) segment.push(p);
        prePad = [];
      }
      segmentMs += durationMs;
      silenceMs = 0;
      segment.push(data);
      if (segmentMs > MAX_SEGMENT_MS) flushWithPad();
    } else if (speechActive) {
      segmentMs += durationMs;
      silenceMs += durationMs;
      segment.push(data);
      if (silenceMs > SILENCE_TIMEOUT_MS) flushWithPad();
    } else {
      prePad.push(data);
      const keepMs = PRE_PAD_MS;
      let total = 0;
      let cut = 0;
      for (let i = prePad.length - 1; i >= 0; i--) {
        total += prePad[i].length / SAMPLE_RATE * 1e3;
        if (total > keepMs) {
          cut = i + 1;
          break;
        }
      }
      if (cut > 0) prePad = prePad.slice(cut);
    }
  };
  const startRecorder = async () => {
    if (active) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(BUFFER_MS * (SAMPLE_RATE / 1e3), 1, 1);
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      handleAudio(new Float32Array(input));
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    active = true;
  };
  const stopRecorder = async () => {
    if (!active) return;
    active = false;
    inFlush = true;
    try {
      if (speechActive) {
        const padSamples = Math.floor(POST_PAD_MS / 1e3 * SAMPLE_RATE);
        segment.push(new Float32Array(padSamples));
        finalizeSegment();
      } else {
        segment = [];
      }
      prePad = [];
    } finally {
      inFlush = false;
    }
    try {
      processor?.disconnect();
    } catch {
    }
    processor = null;
    try {
      void stream?.getTracks().forEach((t) => t.stop());
    } catch {
    }
    stream = null;
    try {
      await audioCtx?.close();
    } catch {
    }
    audioCtx = null;
  };
  return {
    get state() {
      return state;
    },
    async start() {
      if (active) return;
      setState("recording");
      await startRecorder();
    },
    async stop() {
      if (!active) {
        setState("idle");
        return;
      }
      await stopRecorder();
      if (!transcribing) setState("idle");
    },
    onSegment(fn) {
      transcriptListeners.add(fn);
      return () => {
        transcriptListeners.delete(fn);
      };
    },
    onState(fn) {
      stateListeners.add(fn);
      fn(state);
      return () => {
        stateListeners.delete(fn);
      };
    },
    onSpeechStart(fn) {
      speechStartListeners.add(fn);
      return () => {
        speechStartListeners.delete(fn);
      };
    },
    setTranscriptHandler(fn) {
      transcriptListeners.clear();
      transcriptListeners.add(fn);
    }
  };
}

// src/client.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "sessions"];
function apply(ctx) {
  const engine = createAudioEngine();
  ctx.slots.inject(
    "shell.overlay",
    () => ctx.slots.register(
      {
        name: "shell.overlay",
        id: "voice",
        order: 100,
        inject: () => engine
      },
      VoicePanel
    )
  );
  ctx.slots.inject(
    "conversation.input.right",
    () => ctx.slots.register(
      {
        name: "conversation.input.right",
        id: "voice-mic",
        order: 50,
        // Barge-in primitives: skipPlayback is always safe (silence TTS +
        // drop the host synthesis queue); cancelTurn is the stop-button
        // route and is only fired while the session has a running turn.
        inject: (sessionId) => ({
          skipPlayback: () => {
            engine.skip();
            if (sessionId !== void 0) {
              void fetch("/dsh-voice-api/cancel", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId })
              }).catch(() => {
              });
            }
          },
          cancelTurn: () => {
            if (sessionId === void 0) return;
            void ctx.sessions.binding(sessionId)?.session.cancel().catch(() => {
            });
          }
        })
      },
      MicButton
    )
  );
}
function base64ToAudioUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}
function createAudioEngine() {
  const listeners = /* @__PURE__ */ new Set();
  let state = { connected: false, playing: false, caption: null };
  const queue = [];
  const audio = new Audio();
  let source = null;
  const notify = () => {
    for (const fn of listeners) fn(state);
  };
  const setState = (patch) => {
    state = { ...state, ...patch };
    notify();
  };
  const playNext = () => {
    const frame = queue.shift();
    if (!frame) {
      setState({ playing: false, caption: null });
      return;
    }
    const url = base64ToAudioUrl(frame.audio);
    audio.src = url;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      playNext();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      playNext();
    };
    setState({ playing: true, caption: frame.text });
    void audio.play().catch(() => {
      setState({ playing: false });
    });
  };
  const connect = () => {
    if (source) return;
    source = new EventSource("/dsh-voice-api/stream");
    source.onopen = () => setState({ connected: true });
    source.onerror = () => setState({ connected: false });
    source.addEventListener("audio", (e) => {
      const frame = JSON.parse(e.data);
      queue.push(frame);
      if (audio.paused) playNext();
    });
  };
  const skip = () => {
    queue.length = 0;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    setState({ playing: false, caption: null });
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    fn(state);
    return () => {
      listeners.delete(fn);
    };
  };
  return { connect, skip, subscribe };
}
function VoicePanel(props) {
  const { connect, skip, subscribe } = props;
  const [state, setState] = (0, import_react.useState)({
    connected: false,
    playing: false,
    caption: null
  });
  (0, import_react.useEffect)(() => {
    connect();
    return subscribe(setState);
  }, [connect, subscribe]);
  const dot = state.connected && state.playing ? "#1a7f37" : state.connected ? "#57606a" : "#b42318";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: {
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
        pointerEvents: "auto",
        background: "rgba(28, 30, 34, 0.92)",
        color: "#fff",
        maxWidth: 420
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            style: {
              width: 8,
              height: 8,
              borderRadius: 999,
              background: dot,
              flexShrink: 0
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: state.caption ?? (state.connected ? "voice ready" : "voice offline") }),
        state.playing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            onClick: skip,
            style: {
              border: "none",
              background: "rgba(255,255,255,0.16)",
              color: "#fff",
              borderRadius: 999,
              padding: "2px 10px",
              fontSize: 11,
              cursor: "pointer",
              flexShrink: 0
            },
            children: "skip"
          }
        ) : null
      ]
    }
  );
}
var STATE_LABEL = {
  idle: "voice: tap to speak",
  recording: "voice: listening\u2026",
  speech: "voice: speaking\u2026",
  transcribing: "voice: transcribing\u2026",
  "loading-model": "voice: loading whisper\u2026"
};
var STATE_COLOR = {
  idle: "#57606a",
  recording: "#b42318",
  speech: "#1a7f37",
  transcribing: "#0969da",
  "loading-model": "#8250df"
};
function MicButton({ useSession, useInput, inputActions, skipPlayback, cancelTurn }) {
  const [asrState, setAsrState] = (0, import_react.useState)("idle");
  const [error, setError] = (0, import_react.useState)(null);
  const engineRef = (0, import_react.useRef)(null);
  const configRef = (0, import_react.useRef)(null);
  const actionsRef = (0, import_react.useRef)(inputActions);
  const draftRef = (0, import_react.useRef)("");
  const runningRef = (0, import_react.useRef)(false);
  const draft = useInput ? useInput((s) => s === void 0 ? void 0 : s.draft) : void 0;
  const running = useSession ? useSession((s) => s === void 0 ? void 0 : s.running) : void 0;
  const bargeRef = (0, import_react.useRef)({ skipPlayback, cancelTurn });
  (0, import_react.useEffect)(() => {
    bargeRef.current = { skipPlayback, cancelTurn };
  }, [skipPlayback, cancelTurn]);
  (0, import_react.useEffect)(() => {
    actionsRef.current = inputActions;
  }, [inputActions]);
  (0, import_react.useEffect)(() => {
    if (draft !== void 0) draftRef.current = String(draft ?? "");
  }, [draft]);
  (0, import_react.useEffect)(() => {
    runningRef.current = running === true;
  }, [running]);
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    fetch("/dsh-voice-api/config").then((r) => r.json()).then((c) => {
      if (cancelled) return;
      configRef.current = c.asr;
      const engine = createAsrEngine(c.asr);
      engine.onState(setAsrState);
      engine.onSpeechStart(() => {
        const { skipPlayback: skip, cancelTurn: cancel } = bargeRef.current;
        skip();
        if (runningRef.current) cancel();
      });
      engine.onSegment((text) => {
        const actions = actionsRef.current;
        if (!actions || typeof actions.setDraft !== "function") return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const current = draftRef.current;
        const next = current.trim() === "" ? trimmed : current.replace(/\s+$/, "") + " " + trimmed;
        actions.setDraft(next);
        if (c.asr.autoSend && typeof actions.submit === "function") {
          setTimeout(() => {
            try {
              actions.submit?.();
            } catch {
            }
          }, 60);
        }
      });
      engineRef.current = engine;
    }).catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
      void engineRef.current?.stop();
      engineRef.current = null;
    };
  }, []);
  (0, import_react.useEffect)(() => {
    if (error === null) return;
    const t = setTimeout(() => setError(null), 4e3);
    return () => clearTimeout(t);
  }, [error]);
  const toggle = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setError(null);
    try {
      if (engine.state === "idle") {
        await engine.start();
      } else {
        await engine.stop();
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  const holdProps = configRef.current?.mode === "hold" ? {
    onPointerDown: () => void engineRef.current?.start(),
    onPointerUp: () => void engineRef.current?.stop()
  } : {};
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "button",
    {
      onClick: toggle,
      ...holdProps,
      title: error ?? STATE_LABEL[asrState],
      style: {
        border: "none",
        background: "transparent",
        cursor: "pointer",
        padding: 4,
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontFamily: "system-ui, sans-serif",
        color: error ? "#b42318" : "#57606a"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            style: {
              width: 10,
              height: 10,
              borderRadius: 999,
              background: error ? "#b42318" : STATE_COLOR[asrState],
              display: "inline-block",
              flexShrink: 0
            }
          }
        ),
        asrState === "idle" ? "mic" : error ?? STATE_LABEL[asrState].replace("voice: ", "")
      ]
    }
  );
}
return module.exports; } });
