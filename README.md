# Shownotes

Turn a developer livestream MP4 into a local transcript and ready-to-paste YouTube publishing copy. Use the local web interface to choose from **five title candidates** and **two descriptions**, or use the CLI for a repeatable pipeline.

Video stays on your computer. ffmpeg extracts audio and whisper.cpp transcribes it locally. **Transcript text is sent to Anthropic** for one structured-output request. The app does not upload videos to an AI service or publish anything to YouTube.

## Requirements

- Node.js 22.12 or newer and npm.
- ffmpeg and whisper.cpp (`whisper-cli`), installed separately.
- A local ggml Whisper model. `large-v3-turbo` works; its `q5_0` quantized variant uses less memory and is a practical choice on memory-constrained Macs.
- 1Password desktop app with CLI integration enabled, and the `op` CLI on PATH.
- An Anthropic API key stored in 1Password with API billing available.

No model or system binary is automatically downloaded by Shownotes. On Apple Silicon, use a whisper.cpp build with Metal support. Transcription can consume substantial memory; avoid running multiple jobs simultaneously.

## First setup

```sh
npm ci
cp .env.example .env.local
```

Edit `.env.local` with a **reference**, not a plaintext secret:

```dotenv
ANTHROPIC_API_KEY=op(op://YOUR_VAULT/YOUR_ITEM/YOUR_FIELD)
WHISPER_MODEL=/absolute/path/to/ggml-large-v3-turbo.bin
WHISPER_BINARY=whisper-cli
```

Replace the placeholder with the secret reference copied from your own 1Password field. Keep the 1Password app unlocked and enable its developer CLI integration. Varlock’s official 1Password plugin resolves the reference when you start the application; it may ask you to authorize desktop access. No `op read`, export, or plaintext secret file is needed.

The checked-in `.env.schema` declares the plugin and marks the API key required and sensitive. `.env.local` is ignored by Git. The startup commands disable persistent Varlock caching and inject runtime variables only. The API key is never sent to the browser or to ffmpeg/Whisper subprocesses. Tests use a synthetic override and do not access 1Password.

For this workstation, local binary/model paths and the supplied secret reference have already been configured. Do not overwrite an existing `.env.local` with the example.

## Start the local interface

```sh
npm start
```

Open **http://127.0.0.1:4317**. This command builds the app and launches the server through Varlock.

1. Drop one MP4 onto the upload area, or use the keyboard-accessible file picker.
2. Leave **Reuse a matching transcript** checked to avoid repeat transcription. Uncheck it to regenerate the transcript.
3. Select **Generate shownotes**. Progress reports upload, extraction, local transcription, and candidate generation. It reports stages, not a predicted completion time.
4. Select a preferred title and description. Copy buttons remain disabled until a choice is made. **Copy selected description** includes the chapters.
5. Copy tags and, if needed, the separate chapter list. Clipboard success or failure is announced. If the browser denies clipboard access, select and copy the visible text manually.

Keep the page open during processing. One recording can run at a time. Uploads stream to disk, default to a 4096 MB limit, and must have an MP4 filename, media type, and ISO media header. ffmpeg performs the actual media decoding. The server binds only to `127.0.0.1`, checks the Host and Origin, and requires a per-session token for API requests. Do not expose it through a proxy or tunnel.

The web app saves output under `output/<video-sha256>/` and shows the exact path after completion. Selecting a candidate affects clipboard output; the saved Markdown keeps candidate 1 as its default and includes all alternatives. Choices are not persisted across page reloads.

Stop with Ctrl-C. Normal errors and graceful shutdown remove temporary uploads/audio, while intentional transcripts and briefs remain. An OS crash or forced kill can leave `.upload-*` or `.shownotes-*` directories; remove these only while the server is stopped. Never delete a directory belonging to a running job.

## CLI

Build once after checkout or source changes:

```sh
npm run build
npm run brief -- ./recording.mp4 --out ./output
```

The `brief` script runs the compiled `video-brief` CLI through Varlock. Help does not require secrets:

```sh
node dist/cli.js --help
```

Options:

| Option               | Behavior                                                           |
| -------------------- | ------------------------------------------------------------------ |
| `--model FILE`       | Override the local model path from `WHISPER_MODEL`.                |
| `--out DIRECTORY`    | Output directory; defaults to beside the input.                    |
| `--skip-transcribe`  | Require an existing valid cache; fail clearly if missing or stale. |
| `--force-transcribe` | Ignore a matching cache and transcribe again.                      |
| `--help`, `-h`       | Show usage.                                                        |

Matching cache entries are reused automatically even without `--skip-transcribe`. Do not combine the skip and force options. The CLI chooses title candidate 1 and description candidate 1 as readable defaults; alternatives remain in the brief.

For `recording.mp4`, the output bundle contains:

- `recording.transcript.txt`: the reusable plain-text transcript.
- `recording.transcript.json`: versioned cache with segment text, millisecond timestamps, video SHA-256, binary configuration, and model path/size/modification time.
- `recording.brief.md`: default publishing copy, chapters, tags, all five titles, and the alternative description.

The cache validates video content, the binary setting, and the configured model identity. Changing any of these invalidates it. Manually replacing a model while preserving both its size and modification time requires `--force-transcribe`. Cache-only CLI runs can omit a model path; when a model is configured, it must exist and match. Same-name CLI inputs in one output directory overwrite the previous bundle after successful processing; their hashes prevent accidental transcript reuse. Use separate output directories when you want to retain both.

Transcripts are saved before requesting Claude, so API failure does not waste completed transcription. A failed run preserves an earlier brief; that earlier file has not been regenerated. Rerunning distillation makes another paid API request. Automatic SDK retries are disabled.

## Configuration

Put non-secret overrides alongside the reference in `.env.local`:

| Variable         | Default                                                  |
| ---------------- | -------------------------------------------------------- |
| `WHISPER_MODEL`  | Required for fresh transcription; no automatic download. |
| `WHISPER_BINARY` | `whisper-cli`                                            |
| `CLAUDE_MODEL`   | `claude-haiku-4-5-20251001`                              |
| `SHOWNOTES_OUT`  | `output` (web interface only)                            |
| `PORT`           | `4317`                                                   |
| `MAX_UPLOAD_MB`  | `4096`                                                   |

The app requests five distinct titles, two distinct descriptions of two or three paragraphs, five to eight topic-shift chapters, and five to ten tags. Claude chooses segment IDs; the application derives chapter times from those boundaries, starts the first chapter at 00:00, and requires ten-second spacing. Recordings too short or sparse for five valid chapters can fail validation. This version targets 30–60 minute developer recordings. Review generated copy before publication; no paid quality evaluation is included in the automated suite.

## Development and verification

```sh
npm run quality
```

Runs Vitest, Oxlint, Stylelint, Oxfmt checks, TypeScript checks, and the build. Default tests do not need models, media, secrets, vault access, or paid requests. They cover subprocess arguments/errors/cancellation, Whisper JSON parsing, SDK structured-output parsing with a mocked transport, cache invalidation, cleanup, loopback upload protections, DOM selection/copy, drag/drop, submission and error flows. UI tests use jsdom, not a real browser.

Opt-in real-binary test on macOS (generates public-safe speech using `say`; no user recording or API call):

```sh
SHOWNOTES_INTEGRATION=1 WHISPER_MODEL=/absolute/path/to/model.bin npm test -- tests/integration.test.ts
```

Set `WHISPER_BINARY` too if it is not on PATH. The test encodes generated speech as MP4, extracts PCM WAV, runs Whisper, and asserts recognized speech and timestamps. Allow several minutes for model loading on a constrained machine. Each subprocess has a five-minute cancellation bound.

Modules are separate and take explicit inputs: `audio.ts`, `transcription.ts`, and `distillation.ts`. `pipeline.ts` manages caching/output; `cli.ts` and `server.ts` share it. Browser modules import no Node runtime dependencies.

Calavera Composer supplied TypeScript, Oxlint, Oxfmt, Stylelint Standard/Baseline, Varlock, and the checked-in skills. Its recipe, artifact lock, and managed state are retained; downloaded package caches are ignored. Project-specific package scripts and TypeScript settings were intentionally adapted for Node ESM, browser modules, tests, and a separate build. Preview future Calavera reapplication and reconcile these intentional changes before applying it. `quality` deliberately does not resolve live secrets.

## Verified upstream contracts

- [whisper.cpp CLI parser and JSON writer](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp): text/JSON flags, extensionless output prefix, and segment millisecond offsets.
- [Anthropic TypeScript Messages source](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) and [Zod helper](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts): `messages.parse`, `output_config.format`, original-schema validation.
- [Varlock 1Password plugin](https://varlock.dev/plugins/1password/): plugin initialization, desktop authentication and `op()` references. The installed parser is exercised with synthetic overrides in tests.
- [YouTube chapter requirements](https://support.google.com/youtube/answer/9884579): first timestamp 00:00, ordered chapters and a minimum ten-second length.

MIT licensed. No automatic upload, speaker diarization, remote hosting, or automatic model download.
