# context-watch

Warn when a session's context window usage crosses a configurable threshold. An [opencode](https://opencode.ai) plugin that injects a warning into the conversation so the agent can wrap up the current step or prepare for compaction before the window is full.

## How it works

- `experimental.chat.messages.transform` reads the real context size from the most recent completed assistant message's provider-reported token counts (the same number opencode's TUI context meter shows), then — when the threshold is crossed — pushes a synthetic user message into `output.messages` so the warning is visible to the model as part of the conversation.
- `experimental.chat.system.transform` caches the model's context window from `model.limit.context` because the messages transform does not receive model info.

## Installation

Register in `opencode.json`:

```json
{
  "plugin": ["./plugins/context-watch/src/index.ts"]
}
```

## Configuration

Config file (optional): `~/.config/opencode/context-watch.json`

```json
{
  "mode": "percent",
  "warnThreshold": 0.75,
  "rearmPercent": 2,
  "message": "[context-watch] Context window usage is at {percent}% ({tokens}/{window} tokens). The session is getting full: wrap up the current step soon, keep replies concise, avoid re-reading large files, and be ready to prepare for compaction if you continue."
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `"percent"` | `"percent"` or `"tokens"` |
| `warnThreshold` | `0.77` | 0..1, or percent (e.g. 77) if > 1 (percent mode) |
| `warnTokens` | `100000` | Warn when session reaches this many tokens (tokens mode) |
| `rearmPercent` | `5` | Re-warn after this many percentage-point rise (percent mode) |
| `rearmTokens` | `5000` | Re-warn after this many more tokens (tokens mode) |
| `toast` | `true` | Show a TUI toast when a band is crossed |
| `verbose` | `false` | Log context estimates to the opencode log |
| `message` | — | Template; placeholders `{percent}` `{tokens}` `{window}` |

### Env overrides

`CONTEXT_WATCH_MODE`, `CONTEXT_WATCH_THRESHOLD`, `CONTEXT_WATCH_TOKENS`, `CONTEXT_WATCH_WINDOW`, `CONTEXT_WATCH_REARM`, `CONTEXT_WATCH_REARM_TOKENS`, `CONTEXT_WATCH_MESSAGE`, `CONTEXT_WATCH_NO_TOAST`

### Notes

- In `tokens` mode the window is optional; `{percent}`/`{window}` render `0`/`unknown` when the model window is not known.
- In `percent` mode the model window must be known (cached by `system.transform` in the live TUI; pass `CONTEXT_WATCH_WINDOW` when using `opencode run`).

## Development

```sh
./dev.sh format lint typecheck
./dev.sh all
```

## License

MIT
