# opencode-context-watch: Design & Technical Reference

An [opencode](https://opencode.ai) plugin that warns the agent when a session's context window usage crosses a threshold, so it can wrap up the current step or prepare for compaction before the window fills.

## Architecture

The plugin hooks two experimental opencode lifecycle events in one turn:

```
model request ──► experimental.chat.system.transform ──► experimental.chat.messages.transform ──► provider
                        │                                          │
                        └─ cache window (per sessionID)             └─ read context tokens,
                             from input.model.limit.context             check thresholds,
                                                                        inject synthetic warning
```

| Hook | Role |
|------|------|
| `experimental.chat.system.transform` | Runs once per turn with model metadata. Caches `input.model.limit.context` (the model's context window) per `sessionID` in `windowCache`. This is the ONLY place model info is available. |
| `experimental.chat.messages.transform` | Runs with the fully assembled message list. Computes the current context size, compares against thresholds, and pushes a synthetic user message into `output.messages` so the warning reaches the provider as part of the conversation. |

### Context-size ground truth

`contextTokens()` (`src/index.ts:110`) walks the message list from the most recent assistant message backwards and returns the first completed one's:

```
input + output + reasoning + cache.read + cache.write
```

This is the same number opencode's TUI context meter shows. Two correctness rules follow from this:

- **Never sum `tokens.input` across messages.** Each assistant message's `tokens.input` is the *whole context at request time* (a snapshot), so summing overcounts badly.
- Skip any assistant message whose `tokens.input` or `tokens.output` is `<= 0` (in-flight/empty) — only a completed message is a valid sample.

### Threshold model: dual band, OR semantics

The plugin warns when **either** band is crossed (`src/index.ts:159-162`):

- **Percent band** — `tokens / window >= warnPercent`. Requires a known model window; when the window is unknown this band is disabled.
- **Tokens band** — `tokens >= warnTokens`. Absolute, window-independent.

This means `warnPercent: 0.77` with `warnTokens: 100000` warns whichever comes first. For a 200k window model, 0.77 is 154k tokens — the percent band fires first. On a small-window model, the tokens band can fire first.

### Rearm band

`lastWarned` maps `sessionID → { pct, tokens }` (last value each band was notified at). A band re-notifies (toast + verbose log) only after rising by `rearmPercent` points or `rearmTokens` tokens since the last notify. **The rearm band does NOT gate the model injection** — see the critical gotcha below.

### Warning injection

When above threshold, the plugin pushes a synthetic user message (`role: "user"`, `synthetic: true`) carrying the rendered template (`{percent}` `{tokens}` `{window}` placeholders replaced). The message ID/time are generated fresh each push (`msg_cw_<base36 timestamp>`). The agent/model metadata are cloned from the last real user message when available, so the synthetic message looks like a normal user turn to the provider.

## Critical design gotchas

### The injection is transient — push on EVERY turn

The synthetic message is pushed into the *current transform call's in-memory* message array. It is **never persisted to the session store**; the session loop re-reads messages from the store on each step. Therefore, if the plugin injected only on the first turn above threshold, the warning would appear in that step's assembled context but vanish on the next step (tool calls, follow-ups). **The warning must be pushed on every `messages.transform` call while above threshold.** `lastWarned` gates only the toast and verbose log, never the injection.

### Config is read once at load

`loadOptions()` runs when the plugin module loads; the file `~/.config/opencode/context-watch.json` is read a single time. **Changes require an opencode restart.**

### Percent mode needs a known window

- Live TUI: window is cached per session via `system.transform` automatically.
- `opencode run` (headless/CI): no TUI, so no cache — pass `CONTEXT_WATCH_WINDOW` explicitly, or the percent band silently stays disabled (tokens band still applies).

## Configuration

Config file (optional): `~/.config/opencode/context-watch.json`. Read once at load; restart to apply.

| Key | Default | Description |
|-----|---------|-------------|
| `warnPercent` | `0.77` | 0..1, or percent (e.g. `77`) if > 1. Warn when `tokens/window` crosses this. |
| `warnTokens` | `100000` | Warn when the session reaches this many tokens (absolute). |
| `windowTokens` | `null` | Override the model's context window (tokens). |
| `rearmPercent` | `5` | Re-warn after this many percentage-point rise (percent band). |
| `rearmTokens` | `5000` | Re-warn after this many more tokens (tokens band). |
| `toast` | `true` | Show a TUI toast when a band is crossed. |
| `verbose` | `false` | Log context estimates to the opencode log (`client.app.log`). |
| `message` | default template | Injection template; placeholders `{percent}` `{tokens}` `{window}`. |

### Environment overrides (win over file)

`CONTEXT_WATCH_PERCENT`, `CONTEXT_WATCH_TOKENS`, `CONTEXT_WATCH_WINDOW`, `CONTEXT_WATCH_REARM`, `CONTEXT_WATCH_REARM_TOKENS`, `CONTEXT_WATCH_MESSAGE`, `CONTEXT_WATCH_NO_TOAST`.

`warnPercent` normalization: values > 1 are divided by 100 (so `77` and `0.77` both mean 77%). `windowTokens` values <= 0 are treated as unknown (`null`).

## Verification

```sh
# Typecheck
npx tsc --noEmit

# Bundle check
bun build src/index.ts --outdir dist

# Smoke test — inject a warning on the first turn (expect the marker echoed)
cd /tmp/opencode/ctxwatch-runtest && \
  CONTEXT_WATCH_PERCENT=0.001 CONTEXT_WATCH_WINDOW=200000 \
  CONTEXT_WATCH_MESSAGE="...CWVERIFIED..." \
  opencode run --print-logs "Read hello.txt and tell me what it says"
```

## Model window reference

- `opencode/deepseek-v4-flash-free`: **200k** window (NOT 1M — that is `deepseek/deepseek-v4-flash`).
