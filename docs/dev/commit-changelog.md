# Commit & Changelog Conventions

## `changelog:` body key

Only commits with a `changelog:` line in the body appear in the release notes.
The value becomes the changelog entry text.

```
feat: Add batch processing

changelog: Added batch processing for large datasets
```

Commits without `changelog:` are **silently excluded** from the changelog.
Use this for refactors, CI changes, dev tooling, or any internal-only work.

### When to use `changelog:` — two audiences

The definition of "user-facing" depends on your project's audience:

- **Developers (library / crate)** — your users are other developers. Add
  `changelog:` when the change affects the public API, adds new features,
  improves performance, or fixes bugs. Skip internal refactors, test
  additions, CI changes, or dev documentation.

- **App consumers (binary)** — your users are end users of the application.
  Add `changelog:` for UI changes, new features, performance improvements,
  bug fixes, or user-facing documentation. Skip refactors, developer
  tooling, internal docs, CI, or test-only changes.

| Audience    | `changelog:` (include)                      | No key (exclude)                   |
|-------------|---------------------------------------------|------------------------------------|
| Developer   | API changes, new features, perf, bug fixes  | Refactors, CI, dev docs, tests     |
| App user    | UI changes, new features, perf, bug fixes   | Refactors, CI, dev tooling, tests  |

## Writing a public changelog entry

The `changelog:` value becomes the entry **verbatim** in the release notes.
Write it as a complete, user-facing statement about what shipped.

### Voice and tense

Start with the verb, in the **past tense**:

- `Added ...`, `Fixed ...`, `Improved ...`, `Removed ...`

Keep the tense consistent. Do not mix in the imperative form used in commit
subjects (`Add ...`, `Fix ...`) — the entry reports what was done, it does not
instruct the reader.

### Sentence structure

- One line, sentence case, no trailing period.
- Verb first, then the user-visible outcome.
- Keep it short — aim for under 120 characters.
- Inline markdown is allowed: backticks for endpoints, paths, and flags.

```
feat(api): add user search endpoint

changelog: Added a `/api/users/search` endpoint with pagination
```

Not:

```
changelog: search users endpoint /api/users/search pagination added
```

### Content rules

Describe the **outcome**, not the implementation:

- Say what the user can now do or see.
- No function names, internal identifiers, or code structure.
- No commit hashes, PR numbers, or issue references.
- No jargon unless the audience already uses it.

| Do                                            | Don't                                      |
|-----------------------------------------------|--------------------------------------------|
| Added batch processing for large datasets     | Add batch processing (refactored engine.rs)|
| Fixed null pointer crash in the parser        | fix null crash, closes #42                 |
| Improved startup time by 40%                  | Perf improvements to startup               |

### Breaking changes

Declare breaking changes with a conventional `BREAKING CHANGE:` footer in the
commit body. It renders under a "Breaking Changes" section regardless of the
entry text. Pair it with a `chore!(major)` subject when the version must bump
major.

```
feat(config): switch to YAML config files

changelog: Switched configuration to YAML files
BREAKING CHANGE: The legacy JSON config format is no longer supported
```

## Commit message format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

- **type** — `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `ci`, `chore`,
  `style`, `build`, `revert`
- **scope** — optional; reflects the area of the codebase being changed
- **subject** — not used in the changelog; kept short and technical

```
feat(config): Add support for YAML config files

changelog: Added YAML config file support
fix(parser): Handle null values gracefully

changelog: Fixed null pointer crash in parser
```

### Bump control

Bump type is controlled by the commit subject, independent of `changelog:`:

| Subject                  | Bump    |
|--------------------------|---------|
| `chore!(major): ...`     | major   |
| `chore!(minor): ...`     | minor   |
| everything else          | patch   |

Workspace members are bumped independently based on **file path changes**
under `crates/<member>/`, not commit scope. The CI runs `git diff` since the
last tag to detect which member directories have changes. Commit scope is a
human-readable convention and has no effect on bump logic.

### Commit body overrides

Additional fields in the commit body modify how entries appear in the
changelog:

```
feat(api): add user search endpoint

scope: Users
changelog: New `/api/users/search` endpoint with pagination
```

- **`scope:`** — overrides the changelog section/group for this entry.
  Defaults to the commit type label (e.g., "New Features", "Bug Fixes").
- **`changelog:`** — the changelog entry text. Required for inclusion.

## PR-level overrides

Add sections to any **maintainer-authored PR comment** (not the PR body) to
override auto-detection. The bot picks up the latest maintainer comment
containing overrides.

### `## Bump` — manual version bumps

```
## Bump
natmap: minor
auto-discover: patch
```

Each line: `<scope>: <major|minor|patch>`. Overrides the automatic
scope-based detection for workspace crate bumps.

### `## Override Changelog` — full changelog replacement

```
## Override Changelog
### Breaking Changes
- Dropped support for legacy config format (v1)

### New Features
- Added multi-threaded file watcher
- New `--watch` flag for live reload
```

Replaces the entire auto-generated changelog. Also skips the TriPSs
generation entirely.

Both sections are optional and can be used together in the same comment.
`## Bump` controls the version bump table; `## Override Changelog` replaces
the generated changelog text. Each overrides its respective auto-detection.
If neither is present, the system falls back to auto-detection.

## `version-title` — release header title

Optionally give a release a short title that appears next to the version in
the changelog header:

```
## 0.1.5: Some features & bug fixes (2026-08-02)
```

instead of the default:

```
## 0.1.5 (2026-08-02)
```

Create `.github/version-title` in the project repo with the title as the
first non-empty line:

```
Some features & bug fixes
```

- **Version not included** — the version is still auto-bumped from commits.
  The file holds only the title text.
- **Optional per project** — projects without the file (or with an empty
  file) keep the plain `## 0.1.5 (2026-08-02)` header.
- **Applies to the newest release only** — previously released entries are
  left untouched.
- The title is picked up automatically by both the PR changelog preview and
  the release changelog, so commit the file on the branch that will be
  released.
- The file is project-local: `sync.sh` never touches it.
