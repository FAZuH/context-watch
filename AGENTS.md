# AGENTS.md - opencode-context-watch

## Overview

An opencode plugin that warns when a session's context window usage crosses a configurable threshold, injecting a synthetic user message so the model can prepare for compaction.

## Build Commands

```bash
# Typecheck
npx tsc --noEmit

# Test typecheck (tests typechecked separately; root tsconfig is src-only)
npx tsc -p tsconfig.test.json --noEmit

# Tests (bun:test, tests/ dir)
bun test

# Bundle check
bun build src/index.ts --outdir dist

# Format (biome)
bunx biome format --write .

# Lint (biome)
bunx biome check .
```

Note: `bunx biome check .` is NOT clean at HEAD — pre-existing `noNonNullAssertion`
errors in `src/index.ts` and `lint` errors in `.github/.config.cjs`. Also, biome
reformats `package.json`/`tsconfig.json`/`.config.cjs` to tabs (HEAD keeps 2-space),
so `dev.sh format` re-dirties them; revert before committing.

## Critical Implementation Notes

- The injected warning is TRANSIENT — it is pushed into the current transform call's in-memory messages array and is never persisted to the session store. The session loop re-reads messages from the store each step, so the warning must be pushed on EVERY `experimental.chat.messages.transform` call while above threshold. The rearm band (`lastWarned`) gates only the toast + verbose log, NOT the injection.
- Token ground truth = the most recent completed assistant message's `input + output + reasoning + cache.read + cache.write` (matches the TUI context meter). Do not sum `tokens.input` across messages — each assistant message's `tokens.input` is the whole context at request time and would overcount.
- The model window is cached per sessionID via `experimental.chat.system.transform` (`input.model.limit.context`); `messages.transform` has no model info.
- The current model `opencode/deepseek-v4-flash-free` has a 200k window (NOT 1M — that's `deepseek/deepseek-v4-flash`).
- Config is read once at load time; changes require an opencode restart.
- Config validation lives in `resolveOptions(raw, env)` (pure, exported): env > file > default precedence, per-key fallback to defaults, each bad value reported as a `{ key, message }` problem. Invalid config shows a TUI error toast (variant `error`) at load + once more on the first `messages.transform` if the load toast failed; it ALWAYS fires even when `toast: false`. The toast path is race-free (synchronous flags, no `.then` mutation, attempts capped at 3).
- Tests use a test-only `configPath` seam on the plugin factory (`plugin({ client }, { configPath })`) because Node/bun `os.homedir()` caches after the first call — per-test HOME isolation does NOT work.

## Code Style

- TypeScript, strict mode, `tsconfig.json` at repo root (lib es2022 + dom, types node).
- No comments unless they explain non-obvious behavior (this plugin has several such comments; keep them).
- Conventional Commits with `changelog:` body key per `docs/dev/commit-changelog.md` conventions; scopes per `docs/dev/commit-scopes.md`.

## License

MIT
