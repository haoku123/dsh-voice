# AGENTS.md — dsh-voice 开发手册

给 AI 编码代理（或新贡献者）的项目速览：架构、命令、约定与已知坑。

## 这是什么

DeepSeek Harness（dsh）全双工语音插件：说话 → SenseVoice 识别 → 模型流式回答 → Edge TTS 朗读，并支持用声音打断（barge-in）。

```
input:  mic ──RMS 端点检测──▶ POST /asr (raw f32 PCM)
                                 │ text (SenseVoice / sherpa-onnx)
                                 ▼
        composer draft ──submit──▶ model stream ──llm/stream tap──▶ SentenceSegmenter
                                                                     │
        browser ◀── SSE /dsh-voice-api/stream ── TtsQueue (msedge-tts) ◀──┘
                  (base64 MP3 帧 + 字幕文本)

barge-in: 语音前沿 ──▶ engine.skip() + POST /cancel (epoch bump)
                     + session.cancel()（仅当有 running turn）
```

## 命令

```bash
npm install          # sherpa-onnx 是运行时依赖，必须装（否则 host 测试崩）
npm run build        # esbuild：lib/index.js (host) + lib/client.js (browser)
npm test             # host 4 套 plain-node 测试 + client vitest 组件测试
npm run test:host    # 仅 host（segmenter / bargein / bargein-semantics / integration）
npm run test:client  # 仅 client（vitest + jsdom）
npm run prefetch     # 预热 SenseVoice 模型到磁盘缓存（需 dsh 已启动）
```

## 目录结构

```
src/index.ts        # host：TTS 队列、SSE、/asr 识别、/hf 缓存代理、llm/stream tap
src/asr.ts          # 浏览器端：getUserMedia + RMS 端点检测 + POST 音频（不含模型）
src/client.tsx      # client half：VoicePanel（字幕浮层）+ MicButton（录音按钮）
src/client.test.tsx # 组件测试（jsdom；mock ./asr.ts 与 fetch）
src/segmenter.ts    # 流式分句（markdown 剥离 + 终止标点切分）
src/tts-queue.ts    # 合成队列 + epoch 机制（打断时丢弃 queued 与 in-flight）
test/*.test.mjs     # host 测试：plain Node，直接 import lib/*.js（先 build）
build.mjs           # 双 half 打包；client 是 __ModuleLoader__ closure 形态
scripts/prefetch.mjs# 通过 /hf 代理预热模型缓存
docs/demo.py        # Pillow 手绘 demo.gif（无需真人录制）
```

## 关键约定（改代码前必读）

1. **ASR 在 host 端跑，不在浏览器**。SenseVoice 通过官方 `sherpa-onnx`（Apache-2.0）Node 包推理；浏览器只做采集/端点检测，POST 原始小端 f32 PCM（16 kHz）。历史上曾用 transformers.js 在浏览器跑 whisper，已废弃（中文效果差、繁体输出、裸导入/CORS/量化 bug 一堆坑）。
2. **client half 打包形态**：`build.mjs` 产出的 `lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 闭包。**不要**改成普通 ESM/CJS。React 及 `@deepseek-ai/dsh-client-*` 必须 external。
3. **client 声明三件套缺一不可**：
   - `package.json` 的 `exports` 必须含 `"./package.json": "./package.json"`（dsh 的 client 扫描器要 `require.resolve(pkg/package.json)`，缺了会**静默跳过**插件）。
   - `exports` 含 `"./client": "./lib/client.js"`。
   - `dsh.client`: `{ platform: "web", inject: [...] }`。
4. **client 组件 inject**：`src/client.tsx` 顶部 `export const inject = ['slots', 'sessions']`，否则宿主报 `cannot get property "slots" without inject`。
5. **llm/stream tap 必须无损**：每个 chunk 原样 yield，segmenter 只旁观。合成绝不能阻塞模型流。
6. **barge-in 三层**：本地播放队列清空 → host `TtsQueue` epoch bump（queued + in-flight 全丢）→ 有 running turn 时 `session.cancel()`。被打断的轮次**不 flush** 尾部半句。
7. **模型缓存**：`/dsh-voice-api/hf` 是 cache-through 代理，落盘到 `cacheDir`（默认 `~/.cache/dsh-voice/models`），支持 Range 与 `.part` 断点续传。CN 网络把 `modelHost` 改成 `https://hf-mirror.com`。
8. **测试分工**：host 用 plain-node（`test/*.test.mjs`，import 编译后的 `lib/*.js`，所以**改完要先 build**）；client 用 vitest + jsdom（`src/*.test.tsx`，mock `./asr.ts` 和 `fetch`，不 import 客户端运行时包——闭包 bundle 不可 import）。

## 已知坑（历史事故，勿重蹈）

- **`npm install` 不能省**：`sherpa-onnx` 在 dependencies 里，没装的话 3 个 host 测试直接 `ERR_MODULE_NOT_FOUND` 崩溃（不是断言失败，是崩）。
- **ScriptProcessor buffer 必须是 2 的幂**：`asr.ts` 里 `BUFFER_SIZE = 1024`。曾用 `BUFFER_MS * (SAMPLE_RATE/1000)` = 1600 → 运行时抛错。
- **whisper-small 没有 q8 encoder**（若将来回退 transformers.js 需注意）；transformers.js 4.2.0 有 q8 decoder optimizer bug（huggingface/transformers.js#1707）。
- **exports 缺 `./package.json`** → 插件静默不加载（连报错都没有）。排查：`curl` 首页看 `__DSH_BOOT__` 的 entries 里有没有该插件。
- **本地开发时 profile 的 `file:` 依赖是拷贝不是软链**：改完 build 后必须 `pnpm remove` + `pnpm add file:...` 重装，并 `md5` 对比两份 `lib/client.js` 一致，再重启 dsh。
- **错误态要在标签上露出**：`MicButton` 的 label 判断中 `error` 必须优先于 `asrState === 'idle'`，否则 host config 拉取失败时用户只看到普通的 `mic`（曾是真 bug，被组件测试抓出）。
- **npm publish**：账号开 2FA，`.npmrc` 需放 granular + bypass 2FA 的 token；`NODE_AUTH_TOKEN` 在 npm 11+ 已失效。发布后 registry CDN 有几分钟缓存延迟，`npm view` 404 不代表失败，去 npmjs.com 网页确认。

## 发布流程

```bash
npm run build && npm test
git add -A && git commit -m "feat: ..."
git push origin main
npm publish --access public
git tag vX.Y.Z && git push origin vX.Y.Z
```
