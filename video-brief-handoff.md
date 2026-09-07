# Build spec: video-to-YouTube-brief CLI

## Context

I record developer livestreams, roughly thirty minutes to an hour long, as MP4 files. After each recording I want a repeatable local pipeline that extracts the audio, transcribes it, and distills the transcript into a YouTube title, description, chapter markers, and tags, so that publishing a recording no longer requires a manual pass through the whole thing.

Transcription should run locally. The distillation step, which turns a transcript into a title and description, may call the Anthropic API, since that step is a single cheap request and there is no equivalent local model worth trading accuracy for.

## Pipeline

The tool takes one MP4 file as input and produces one output bundle. There are three stages, each a discrete, independently testable unit rather than one large script.

**Audio extraction.** Shell out to `ffmpeg` to pull a mono, 16kHz WAV out of the source MP4. This is the format whisper.cpp expects internally, and extracting it up front keeps the transcription stage decoupled from video handling entirely.

**Transcription.** Shell out to a local `whisper.cpp` binary against the extracted WAV, using a `ggml` model already present on disk (do not have the tool download models automatically; treat the model file as a prerequisite the user supplies). Capture both the plain-text transcript and the segment-level timestamps whisper.cpp emits, since the timestamps are what let the distillation stage generate chapter markers later.

**Distillation.** Send the transcript to the Claude API with a single prompt that returns exactly five title candidates, two different two-to-three paragraph descriptions, optional timestamped chapter markers built from the segment data (default five to eight, configurable exact count one to eight and minimum duration one to 3600 seconds, default ten), and five to ten tags. Request structured JSON back rather than parsing prose, since the output needs to be reliably split into those four fields.

## Prerequisites (assume already installed, do not install these)

- `ffmpeg` on PATH
- `whisper.cpp` built locally (Metal acceleration is enabled by default on Apple Silicon through the standard build, so no separate Core ML conversion is required for v1)
- A `ggml` Whisper model file (`large-v3-turbo` is a reasonable default for the speed and accuracy trade-off on a MacBook Air) downloaded to a known path
- `ANTHROPIC_API_KEY` available in the environment

The tool should check for `ffmpeg` and the whisper.cpp binary on PATH at startup and fail with a clear, specific message naming what is missing rather than a raw subprocess error, since this is exactly the kind of failure that otherwise wastes the first ten minutes of a debugging session.

## Interface

A single command, taking the video path and an optional output directory:

```
video-brief ./stream-2026-09-04.mp4 --out ./output
```

Flags worth supporting: `--model` (path to the ggml model, defaulting to a configured value), `--out` (output directory, defaulting to alongside the input file), and `--skip-transcribe` (reuse an existing transcript if one is already on disk for this input, rather than re-running whisper.cpp). That last flag matters more than it looks: transcription is the expensive step, and if I only want to regenerate the title and description with a tweaked prompt, re-running the whole pipeline against the audio again would be wasted cost proportional to the video length rather than to the actual change being made. Cache the transcript keyed on the input file's name (or hash, if collisions become a real concern), and let the distillation stage run against a cached transcript on its own.

## Output

For an input `stream.mp4`, write to the output directory:

- `stream.transcript.txt` — the plain-text transcript, kept around on its own merit as raw material I can reuse for blog posts, not only as pipeline intermediate output
- `stream.transcript.json` — the segment-level data with timestamps
- `stream.brief.md` — the distilled title, description, chapters, and tags, formatted so it can be copied straight into YouTube's upload form

## Stack

Node.js and TypeScript, matching the rest of my tooling. Use `child_process` (or `execa` if a dependency is preferred over the raw API) for the `ffmpeg` and `whisper.cpp` shell-outs, and the official `@anthropic-ai/sdk` for the distillation call. Keep the three pipeline stages as separate, pure-ish modules — audio extraction, transcription, distillation — each exposing a function that takes explicit inputs and returns a typed result, so that none of them reach into global state or assume they are being run in sequence with the others.

## Testing

Follow test-driven development: write the test before the implementation for each unit. Use Vitest for pipeline and HTTP server tests, plus jsdom interaction tests for the local web UI. Cover upload/file selection, candidate selection, clipboard success/failure, progress/errors and confirmed diagnostic cleanup; real-browser acceptance testing is separate from these programmatic tests.

The distillation stage is the most valuable thing to unit test thoroughly, since it is pure logic around prompt construction and response parsing: given a fixed transcript and mocked API response, assert that the JSON gets parsed into the right shape and that malformed or partial responses fail loudly rather than silently producing an empty description. The audio extraction and transcription stages are thin wrappers around subprocesses, so unit tests there should focus on argument construction and error handling (missing binary, non-zero exit code, malformed output) rather than trying to invoke real `ffmpeg` or `whisper.cpp` processes. A small number of integration tests that do invoke the real binaries against a short fixture file are worth having, but gate them behind an environment flag so the default test run does not depend on local binaries being present.

## Definition of done for v1

The tool takes a single MP4 path and, with no further intervention, produces a transcript and a ready-to-paste YouTube brief. Re-running against the same input after a prompt change reuses the cached transcript instead of re-transcribing. Missing `ffmpeg` or `whisper.cpp` produces a clear error naming the missing dependency rather than a stack trace. All three pipeline stages have unit tests written before their implementations.

## Out of scope for v1

Speaker diarization, since these are solo streams. Remote hosting or a public-facing UI. Automatic upload to YouTube. Support for input formats other than MP4. Automatic model downloading.

## Local web UI and resolved decisions

Alongside the CLI, serve a loopback-only web interface with streamed single-MP4 upload, drag/drop and keyboard file selection, stage progress, exactly five title candidates and two descriptions, explicit radio selection and clipboard feedback. Keep the API key server-side, protect API actions with session and loopback Host/Origin checks, and retain matching transcript cache reuse. Both interfaces share the pipeline and diagnostic lifecycle. Diagnostic cleanup shows file names/sizes, requires deliberate deletion, and preserves active runs and final outputs.

Both interfaces expose chapter inclusion, count, and minimum duration. Check segment-aligned feasibility before the paid request, preserve transcript reuse when settings change, and omit empty chapter sections from chapterless results. Choose topic-shift chapters aligned to supplied segment IDs. Derive timestamps locally, starting at 00:00. Output readable Markdown with plain-text, copyable YouTube fields; the CLI defaults to candidate 1 and includes alternatives.
