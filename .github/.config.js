// https://github.com/conventional-changelog/conventional-changelog-config-spec/blob/master/versions/2.2.0/README.md
"use strict";
const fs = require("fs");
const path = require("path");
const config = require("conventional-changelog-conventionalcommits");

// Optional per-project release title. A single non-empty line in
// `.github/version-title` renders as `## 0.1.5: <title> (2026-08-02)`.
// Absent or empty file means no title (plain `## 0.1.5 (2026-08-02)`).
const VERSION_TITLE_FILE = path.join(__dirname, "version-title");

function readVersionTitle() {
  let content;
  try {
    content = fs.readFileSync(VERSION_TITLE_FILE, "utf8");
  } catch (_e) {
    return null;
  }
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line || null;
}

const HEADER_PARTIAL =
  "## {{#if @root.linkCompare~}}\n" +
  "  [{{version}}]({{compareUrlFormat}})\n" +
  "{{~else}}\n" +
  "  {{~version}}\n" +
  "{{~/if}}{{~#if title}}: {{{title}}}{{/if}}{{~#if date}} ({{date}}){{/if}}\n";

function whatBump(commits) {
  const hasMajor = commits.some((c) => c?.header?.startsWith("chore!(major)"));
  const hasMinor = commits.some((c) => c?.header?.startsWith("chore!(minor)"));

  if (hasMajor) {
    return { releaseType: "major", reason: "Found a commit with a chore!(major) type." };
  }
  if (hasMinor) {
    return { releaseType: "minor", reason: "Found a commit with a chore!(minor) type." };
  }
  return { releaseType: "patch", reason: "No special commits found. Defaulting to a patch." };
}

function isPublicCommit(commit) {
  const body = commit.body || "";
  return /^changelog:\s*/im.test(body);
}

const TYPE_LABELS = {
  feat: "New Features",
  fix: "Bug Fixes",
  perf: "Performance Improvements",
  docs: "Documentation",
  revert: "Reverts",
  style: "Styles",
  chore: "Miscellaneous Chores",
  refactor: "Code Refactoring",
  test: "Tests",
  build: "Build System",
  ci: "Continuous Integration",
};

function typeLabel(type) {
  return TYPE_LABELS[type] || type;
}

function extractScope(body, fallback) {
  if (!body) return fallback;

  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return fallback;

  const scopeLine = lines.find((l) => /^scope:\s*/i.test(l));
  if (scopeLine) {
    return scopeLine.replace(/^scope:\s*/i, "").trim();
  }

  return fallback;
}

function extractChangelogText(body) {
  if (!body) return null;

  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return null;

  const changelogLine = lines.find((l) => /^changelog:\s*/i.test(l));
  if (changelogLine) {
    return changelogLine.replace(/^changelog:\s*/i, "").trim();
  }

  return null;
}

async function getOptions() {
  let options = await config({
    types: [{ type: "General", section: "General", hidden: false }],
  });

  options.recommendedBumpOpts.whatBump = whatBump;
  options.whatBump = whatBump;

  if (options.writerOpts) {
    options.writerOpts.headerPartial = HEADER_PARTIAL;
    if (options.writerOpts.transform) {
      const originalTransform = options.writerOpts.transform;
      options.writerOpts.transform = (commit, context) => {
        if (!isPublicCommit(commit)) return null;

        commit.scope = null;

        const originalType = commit.type;
        const scope = extractScope(commit.body, originalType);
        const changelogText = extractChangelogText(commit.body);

        commit.type = scope === originalType ? typeLabel(scope) : scope;

        if (changelogText) {
          commit.subject = changelogText;
        }

        const result = originalTransform(commit, context);
        if (result) {
          if (result.notes) {
            result.notes.forEach((note) => {
              note.text = note.text.trim();
            });
          }
          return result;
        }

        // originalTransform returned null (type not in types list),
        // but commit is public — force it through
        if (commit.hash) {
          commit.shortHash = commit.hash.substring(0, 7);
        }

        if (commit.notes) {
          commit.notes.forEach((note) => {
            note.title = "BREAKING CHANGES";
            note.text = note.text.trim();
          });
        }

        return commit;
      };
    }

    const originalFinalizeContext = options.writerOpts.finalizeContext;
    options.writerOpts.finalizeContext = (context, opts, commits, keyCommit) => {
      if (originalFinalizeContext) {
        context = originalFinalizeContext(context, opts, commits, keyCommit);
      }

      if (context.commitGroups) {
        for (const group of context.commitGroups) {
          if (group.commits && group.commits.length > 0) {
            group.title = group.commits[0].type;
          }
        }
      }

      // `keyCommit` is null only for the newest release chunk — the one being
      // generated. Older chunks (release-count > 1) pass the tag commit, so the
      // title never leaks into previously released entries.
      if (!keyCommit) {
        const title = readVersionTitle();
        if (title) {
          context.title = title;
        }
      }

      return context;
    };
  }

  return options;
}

module.exports = getOptions();
