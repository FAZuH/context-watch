## 0.1.1 (2026-08-05)


### ⚠ BREAKING CHANGES

* The `mode` option, the `warnThreshold` config key, and the `CONTEXT_WATCH_MODE`/`CONTEXT_WATCH_THRESHOLD` env vars are removed. Use `warnPercent` instead of `warnThreshold`; `warnTokens` now runs alongside it instead of being exclusive.

### Continuous Integration

* debug ([12c5ec4](https://github.com/FAZuH/opencode-context-watch/commit/12c5ec4ed3ac57d2afbbebf1d868f5074864dc2b))
* debug ([6a873c5](https://github.com/FAZuH/opencode-context-watch/commit/6a873c5a94c189298c64a58da5efc8b59b608e20))


### New Features

* Warnings now fire when either the percent or token threshold is crossed; renamed `warnThreshold` to `warnPercent` and removed the `mode` option ([3cd960f](https://github.com/FAZuH/opencode-context-watch/commit/3cd960f669f6ed4dfcaba96d737b8ccace71a6a8))

## 0.1.0 (2026-08-05)

