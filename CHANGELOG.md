# Changelog

All notable changes to `pi-compound` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-21

Initial public release.

### Commands

- `/compound` — extract → gate → review → append cycle across recent sessions.
- `/compound:init` — scaffold `~/.pi/agent/compound/` with a starter doc + sidecar.
- `/compound:status` — per-doc summary (last run, approved / rejected / skipped counts).
- `/compound:last [id]` — render the most recent run's report with Stage 2 rejections and survivors; optional substring selector for older runs.
- `/compound:wire` — print and copy the `@`-include lines for all managed docs.

### Pipeline

- **Stage 1** (default: `anthropic/claude-haiku-4-5`): one batched call per session across all managed docs. Reads the full transcript plus all sidecars and proposes plausibly-relevant candidates per doc.
- **Stage 2 gate** (default: `anthropic/claude-opus-4-5`): one call per run across all candidates. Applies strict standards (evidence quality, category fit, principle-vs-mechanics, voice match, confidence recalibration) and can reassign candidates to a different doc before approving.
- **Review TUI**: one proposal at a time, with approve / edit-then-approve / skip / reject-with-reason / abort keybindings.
- **Fallback**: if Stage 2 errors out, Stage 1 candidates are converted to proposals directly with a warning banner.

### Flags on `/compound`

- `--since <spec>` / `--limit N` / `--top N` / `--docs a,b` / `--sessions path1,sub2`
- `--dry-run` — run pipeline, write logs, skip review, no writes to content docs or index.
- `--no-gate` — skip Stage 2.
- `--gate-model provider/id` — override the Stage 2 model.

### Design invariants

1. Append-only. No removal or rewrite of existing doc content.
2. User-gated. No proposal reaches a doc without a keypress.
3. Evidence-grounded. Every proposal cites session path, date, cwd, role-attributed excerpt.
4. Dedup-aware. FNV content hashes persisted for approved and rejected per doc.
5. Doc-agnostic. Zero hardcoded categories; add a `.md` + `.compound.yaml` pair and it works.
6. Read-only on `~/.pi/agent/sessions/`.
7. Content docs ship pristine (no frontmatter, no pipeline metadata).

[Unreleased]: https://github.com/mpsuesser/pi-compound/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mpsuesser/pi-compound/releases/tag/v0.1.0
