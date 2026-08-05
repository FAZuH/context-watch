# Plan: context-watch config-error toast + test suite

## Objective

1. When the plugin's config file or env overrides are invalid, show a TUI error toast listing exactly what is wrong, and fall back to per-key defaults so the plugin keeps working.
2. Add a unit + integration test suite (bun:test) covering the new config validation AND the pre-existing threshold-warning / synthetic-injection behavior, which had zero tests.

## Decisions & constraints

- Invalid value → fall back to that key's default (graceful), never disable the plugin.
- Config-error toast always fires regardless of `toast: false` (it is the mechanism that tells you config is broken).
- Toast timing: fire at plugin load + retry once on the first `messages.transform` if the load-time toast failed (TUI not connected yet).
- Test runner: `bun:test` (bun is the repo toolchain). Tests typechecked with `tsc -p tsconfig.test.json` (`types: ["node","bun"]`); root `tsconfig.json` stays `src`-only.
- Config-error toast uses `client.tui.showToast` variant `"error"`; full problem list also goes to `client.app.log` (level `error`) regardless of `verbose`.
- Env precedence: env > file > default. Invalid env falls back to file; invalid file falls back to default.
- `CONTEXT_WATCH_NO_TOAST` presence check is truthy (empty string does NOT disable toast).

## File layout

- `src/index.ts` — all production changes (validation, resolveOptions, configToast fix, configPath seam).
- `tests/harness.ts` — fake client + isolated-config harness + `buildMessages` helper.
- `tests/resolveOptions.test.ts` — 39 unit tests (pure, table-driven). **PASS.**
- `tests/plugin.test.ts` — 8 integration tests (config-error toast + regressions). **PASS.**
- `tests/warning.test.ts` — 6 core-behavior tests. **WRITTEN, NOT YET VERIFIED** (has a stray duplicate-import line to remove).
- `tsconfig.test.json` — new, typechecks `src` + `tests` with bun types.
- `package.json` — `test` → `bun test`, `test:typecheck` → `tsc -p tsconfig.test.json --noEmit`, devDep `@types/bun`.
- `dev.sh` — added `test` and `test:typecheck` commands, folded into `all`.
- `.github/workflows/_pr-checks.yml` — added "Test typecheck" + "Tests" steps.
- `README.md` — "Configuration errors" section.
- `CHANGELOG.md` — Unreleased entry.

## Design

### Config validation (`resolveOptions`, exported pure function)
`resolveOptions(raw: unknown, env)` validates every option: numeric ranges
(`warnPercent` (0,100], others >0), `windowTokens` `null`-able, booleans,
non-empty `message`, unknown keys flagged, root must be a JSON object. Returns
`{ options, problems }` where `problems: { key, message }[]`. `loadOptions`
is a thin wrapper: read+parse the file (parse errors → `file` problem) then
delegate. `warnPercent` normalizes `> 1` as a percentage.

### Config-error toast
`configToast()` is race-free: `configErrorShown`/`configErrorInFlight` are set
synchronously before the first await; all awaits are inside try/catch so it can
never reject; attempts capped at 3 (headless log-spam guard). Fires at load;
`messages.transform` re-fires once if `!configErrorShown`. Never uses a
`.then()` callback to mutate flags (that pattern caused a dedup race + an
unhandled rejection).

### Testability seam (`configPath`)
`plugin({ client }, { configPath })` — optional second arg. opencode never
passes it; tests use it to point at an isolated temp config file. Required
because Node/bun `os.homedir()` **caches after first call**, so per-test HOME
isolation is impossible via re-import (query-string cache-busting DOES create
fresh module instances, but `homedir()` still returns the first HOME).

## Execution

Verify with:
- `bun test` — expect 53 pass (39 + 8 + 6)
- `bunx tsc --noEmit` and `bunx tsc -p tsconfig.test.json --noEmit`
- `bunx biome check .` and `bunx biome format --write .`
- `bun build src/index.ts --outdir dist`
- `./dev.sh all`
- Optional manual: bad `~/.config/opencode/opencode-context-watch.json` → error toast.

## Deviation log

- [2026-08-06] Original plan said "cache-busted fresh import + temp HOME" for
  integration tests. **Abandoned**: `os.homedir()` caches after the first call,
  so fresh imports still resolve the first HOME. Replaced with the `configPath`
  DI seam (test-only second arg to the plugin factory).
- [2026-08-06] Ad-hoc verification of the toast found two bugs in the initial
  implementation: (a) load-time `showToast` rejection surfaced as an unhandled
  rejection; (b) the `.then((ok) => configErrorShown = ok)` dedup raced, so the
  toast double-fired. Fixed by rewriting `configToast` with synchronous flags
  and no `.then` mutation; encoded as a failing-then-passing integration test
  (tests/plugin.test.ts "a load-time toast failure…").
- [2026-08-06] `CONTEXT_WATCH_NO_TOAST` empty-string case: empty env value is
  falsy so it does NOT disable toasts — kept original truthy semantics; test
  uses `"1"`.
- [2026-08-06] Tests typecheck via separate `tsconfig.test.json` (+ `@types/bun`)
  so root `tsc --noEmit` on `src` stays clean.
- [2026-08-06] Pre-existing: `bunx biome check .` fails on 3 `noNonNullAssertion`
  errors in `src/index.ts` (present at HEAD, not introduced here).
- [2026-08-06] `fail()` from `bun:test` does NOT exist as an export (neither in
  @types/bun nor at runtime). The three `?? fail("...")` call sites were dead
  code that had never executed. Replaced with a `must(value, what)` helper in
  tests/harness.ts that throws a plain Error; updated the `fail` imports.
- [2026-08-06] The two `// biome-ignore lint/performance/noDelete` comments in
  tests/harness.ts were flagged `suppressions/unused` — biome's noDelete rule
  does not fire on `delete process.env[var]` here. Removed both comments.
- [2026-08-06] Changed `export { type ConfigProblem }` → `export type { ConfigProblem }` to clear biome `useExportType`.
- [2026-08-06] Biome scans `dist/` (generated bundle) because the repo has no
  biome.json and biome 1.9 does not honor `.gitignore` by default. Lint must be
  run with no `dist/` present (the `all` order format→lint→typecheck→…→bundle
  already does this on a clean checkout).
- [2026-08-06] Final `bunx biome check .` state: 9 errors, ALL pre-existing at
  HEAD (3× `noNonNullAssertion` in src/index.ts + 6 in `.github/.config.cjs`).
  This branch introduces zero new lint findings.
- [2026-08-06] `./dev.sh format` reformats `.github/.config.cjs` and
  `opencode-context-watch.example.json` (HEAD is not biome-format-clean) →
  reverts them after each format run to keep the diff focused. Papercut filed.

## Resume checkpoint
- Goal to re-create: no formal goal existed (plan-driven work). Objective:
  "Add an error toast that lists what is wrong when context-watch config is
  invalid, plus a unit/integration test suite covering config validation and
  the core threshold-warning behavior."
- Next step: fix `tests/warning.test.ts` — delete the stray mid-file line
  `import { buildMessages } from "./harness"` and the `const buildOutput = buildMessages` alias (line ~37); `buildMessages` is already imported at the top; change `runTransform` to call `buildMessages(tokens)` directly. Then run the full verification (below).
- Verify with: `bun test` (expect 53 pass), `bunx tsc -p tsconfig.test.json --noEmit`, `./dev.sh all`.
- Context to re-read first: `src/index.ts` (resolveOptions ~line 99, configToast ~line 290, configPath seam ~line 284), `tests/harness.ts`, `tests/plugin.test.ts` (red/green regression pattern).
- Open questions: none blocking. After green, commit via `/finish` (feature + tests + docs are all uncommitted in the working tree).

## Outcome
- All implementation and test work is DONE and VERIFIED:
  - `bun test` → 53 pass / 0 fail (39 resolveOptions + 8 plugin + 6 warning).
  - `bunx tsc --noEmit` and `bunx tsc -p tsconfig.test.json --noEmit` → clean.
  - `bun build src/index.ts --outdir dist` → bundles 3 modules, 20.55 KB.
  - `bunx biome check tests` → clean; `bunx biome check src` → only the 3
    pre-existing `noNonNullAssertion` errors.
  - Remaining before ship: commit the working tree (feature, tests, infra,
    docs) via `/finish`. Nothing else is outstanding.
- Note: `docs/plan/` itself is untracked; archive this doc to
  `docs/plan/complete/` as part of the commit.
