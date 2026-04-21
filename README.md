# pi-compound

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Turn your past [Pi](https://github.com/badlogic/pi-mono) sessions into context docs for your system prompt — on demand, with review.

You keep a folder of plain-markdown docs, one per category you care about (`how-to-communicate-with-me.md`, `what-i-care-about.md`, whatever). Each doc has a small sidecar YAML that says what belongs in it. You run `/compound`. It reads recent session transcripts, a two-stage LLM pipeline extracts durable preferences (draft → gate), and you approve or reject each one from a TUI.

Approved text is appended verbatim. Your docs are plain markdown, still yours, and the same files you already `@`-include in your Pi system prompt. Every session teaches every future session.

> **Status:** early but working. Tested against sessions up to ~1600 messages. The doc + sidecar schema is stable enough to build on; prompt wording will keep evolving.

---

## Table of contents

- [Why](#why)
- [What it looks like](#what-it-looks-like)
- [Install](#install)
- [Quick start (3 minutes)](#quick-start-3-minutes)
- [Commands](#commands)
- [Anatomy of a compound-managed doc](#anatomy-of-a-compound-managed-doc)
- [The two-stage pipeline](#the-two-stage-pipeline)
- [Flag reference](#flag-reference)
- [Bringing your own context docs](#bringing-your-own-context-docs)
- [Sidecar schema](#sidecar-schema)
- [Dedup and session selection](#dedup-and-session-selection)
- [Cost and model configuration](#cost-and-model-configuration)
- [Design invariants](#design-invariants)
- [FAQ](#faq)
- [Non-goals](#non-goals)
- [Contributing](#contributing)
- [License](#license)

---

## Why

After a few weeks of using any capable coding agent, you start noticing the same frictions recurring across sessions:

- You correct the same stylistic choice (*"stop narrating, just do it"*) every Monday.
- You re-explain the same architectural preference (*"Effect, not Promise"*) every time you switch repos.
- You re-establish the same working agreement (*"ask before choosing a default"*) after every compaction.

The fix, in principle, is simple: write those down once, put them in your system prompt, move on. In practice nobody does, because writing the doc is a context switch from the real work, and you can never remember the exact phrasing in the moment. By the time you *have* the energy to sit down and write it out cleanly, you've forgotten three other things.

`pi-compound` closes that loop. Your past sessions are already the training data. They just need to be mined.

---

## What it looks like

**The review TUI (one proposal at a time):**

```
  Proposal 2 of 3
  what-i-care-about

  anchor       append
  confidence   high
  from         2026-04-14  ~/repos/workspace/dotconfig
  gate         Direct user request to rename based on scope mismatch;
               captures a durable principle about naming honesty.

  ──────────────────────────────────────────────────────────────────

  ## Naming should reflect actual scope

  I care about names that honestly describe what a component does.
  When a module's responsibilities grow beyond its original label,
  rename it. Better a longer accurate name than confusion from drift
  between name and function.

  ──────────────────────────────────────────────────────────────────

  [a] approve    [e] edit then approve    [s] skip    [r] reject with reason    [q] abort
```

**`/compound:last` — audit what the pipeline did:**

```markdown
# pi-compound — last run

**Ran:** 2026-04-21 07:26  ·  **flags:** `--top=3`
**Cost:** $0.5511  (Stage 1 $0.5108 · Stage 2 $0.0404)
**Sessions:** 3  ·  **Docs:** 3

## Stage 1 — `claude-haiku-4-5`
Candidates: **8**

## Stage 2 — `claude-opus-4-5`
Approved: **2**  ·  Rejected: **6**

### Rejections

**1.** `what-i-care-about`  _conf=high_  `cand_478640bdf0`
_reason:_ Evidence cites assistant thinking and assistant actions,
not direct user statements; weak inference chain.

> ## Effect-First Development
> I care deeply about Effect as the primary substrate for new
> TypeScript work...
```

Every proposal is cited to a session path, a date, and a direct user quote. Every rejection has a stated reason you can inspect and appeal.

---

## Install

```bash
# once published to npm:
pi install npm:pi-compound

# or directly from GitHub:
pi install git:github.com/mpsuesser/pi-compound

# or try without installing (per-run):
pi -e git:github.com/mpsuesser/pi-compound
```

For local development:

```bash
git clone https://github.com/mpsuesser/pi-compound
cd pi-compound
pi -e .
```

`pi-compound` is a single TypeScript extension (`src/index.ts`). No build step, no runtime dependencies beyond the Pi peer packages and `yaml`.

---

## Quick start (3 minutes)

```
/compound:init                          # scaffold ~/.pi/agent/compound/ with a starter doc
```

Open `~/.pi/agent/compound/what-i-care-about.compound.yaml` and edit the `criteria:` to match your taste. (The default is a sensible starting point.)

```
/compound --top 1 --dry-run             # run against your juiciest 1 session, no writes
```

Check `~/.pi/agent/compound/.log/` or run `/compound:last` to see what the pipeline produced. Then, for real:

```
/compound --top 1                       # same session, now with the review queue
/compound:wire                          # prints the @include lines for your system prompt
```

Paste the `@` lines into your Pi system prompt config and you're wired up. From then on, every time you've accumulated some sessions worth of signal:

```
/compound --since 7d                    # weekly pass — review whatever the gate surfaces
```

---

## Commands

| Command | What it does |
|---|---|
| `/compound` | Full extract → gate → review → append cycle. Default: 5 most recent sessions × all managed docs. |
| `/compound:init` | Scaffold `~/.pi/agent/compound/` with a starter `what-i-care-about.md` + sidecar. |
| `/compound:status` | Per-doc summary: last run, approved / rejected / skipped counts, recent run IDs. |
| `/compound:last [id]` | Render the most recent run's report — Stage 2 rejections with reasons, survivors with gate notes. Pass a substring of a run filename to inspect an older run. |
| `/compound:wire` | Print (and copy to clipboard) the `@`-include lines for all managed docs, ready to paste into your Pi system prompt. |

---

## Anatomy of a compound-managed doc

A compound-managed doc is **two files sharing a basename**, living in `~/.pi/agent/compound/`:

```
~/.pi/agent/compound/
├── how-to-communicate-with-me.md           ← content doc (ships to your system prompt verbatim)
├── how-to-communicate-with-me.compound.yaml ← sidecar (tells the extractor what belongs here)
├── what-i-care-about.md
├── what-i-care-about.compound.yaml
├── .index.json                              ← machine-managed dedup + run history
└── .log/                                    ← per-run JSON logs
```

**The content doc is pristine markdown.** It contains no frontmatter, no pipeline metadata, nothing that would leak into your system prompt. `@-include` it and only the text you approved ends up in the model's context.

**The sidecar holds everything else.** Purpose, criteria, structure, voice examples, confidence threshold, per-doc model override. This is where the policy for each doc lives.

**A `.md` without a sidecar is ignored.** This lets you mix compound-managed and hand-maintained docs in the same directory without overhead.

Example pairing (from `examples/`):

<details>
<summary><strong><code>how-to-communicate-with-me.md</code></strong> (content — ships to system prompt)</summary>

```markdown
# How To Communicate With Me

(This document accretes via `/compound`. Items below describe how I want
the agent to structure communication with me — voice, tone, pacing,
response length, how to ask questions, what patterns I actively reject.)
```

That's it for initial state. Items get appended below.
</details>

<details>
<summary><strong><code>how-to-communicate-with-me.compound.yaml</code></strong> (sidecar — tells the extractor what belongs)</summary>

```yaml
purpose: >
  Principles for how the agent should structure its communication with me —
  voice, tone, pacing, response length, what to cite, how to ask questions,
  and what patterns I actively reject.

criteria: |
  Propose an item when, in a Pi session, I:
  - corrected the agent's communication style ("don't hedge", "be direct",
    "stop rephrasing my question", "shorter", "cite the line number")
  - expressed a preference for format, tone, or length ("bullet soup",
    "no preamble", "one sentence", "just show me the code")
  - pushed back on a specific phrasing pattern (over-qualification,
    forced positivity, apologies, "I'll do X" narration)
  - specified how questions should be asked ("one at a time",
    "multiple choice", "don't ask, just do")
  - reacted strongly — positive or negative — to a concrete stylistic
    choice the agent made

  DO NOT propose items based on:
  - my task-content preferences (those go in what-i-care-about)
  - my technical assumptions (those go in how-to-assume-with-me)
  - single-session ad-hoc steering that doesn't obviously generalize

structure: |
  Short sections, H2 headings. Each section opens with the principle stated
  in bold imperative voice, followed by 1–3 sentences of elaboration.

  Prefer DO / DO NOT pairs when the guidance is about what NOT to assume
  or do — mirror the style of how-to-assume-with-me.md's "Simple vs
  Correct" section.

  No bullet soup. No hedging language. Second person.

style_examples:
  - |
    ## Don't narrate intent

    **DO NOT** open replies with "I'll do X, then Y, then Z." Just do it.
    Narration burns tokens and reading time. If the plan is non-obvious,
    a one-line summary at the *end* is fine; prefix narration is not.

    **DO** open with the answer, the finding, or the question.

scope:
  min_confidence: medium
  max_proposals_per_run: 5
```
</details>

See `examples/` for three full doc + sidecar pairs (communicate, assume, care-about) you can adapt.

---

## The two-stage pipeline

Naive extraction — one LLM call, ask it to propose context-doc additions — fails in predictable ways. It inflates one-off instructions into "principles," cites assistant monologue as user preference, and produces 6+ medium-confidence items per session where 1 would be honest. You end up with a proposal queue full of noise.

`pi-compound` runs a two-stage pipeline that separates **coverage** from **judgment**:

```
  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
  │ session 1   │  │ session 2   │  │ session 3   │
  │ .jsonl      │  │ .jsonl      │  │ .jsonl      │
  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
         │                │                │
         ▼                ▼                ▼
    ╔══════════════════════════════════════════╗
    ║  STAGE 1  —  Haiku, batched per session  ║
    ║  Reads full transcript + all sidecars,   ║
    ║  proposes plausibly-relevant candidates. ║
    ║  Lenient. Casts a wide net.              ║
    ╚═══════════════════════╦══════════════════╝
                            │
                            ▼    candidates.json
    ╔══════════════════════════════════════════╗
    ║  STAGE 2  —  Opus gate, one call/run     ║
    ║  Applies strict standards per candidate: ║
    ║   · category fit vs target doc           ║
    ║   · evidence is direct user quote        ║
    ║   · principle (durable) vs mechanics     ║
    ║   · confidence recalibration             ║
    ║   · rewrite to match target doc voice    ║
    ║   · reassign doc if mis-categorized      ║
    ║  Reject freely with stated reasons.      ║
    ╚═══════════════════════╦══════════════════╝
                            │
                            ▼    proposals.json
    ╔══════════════════════════════════════════╗
    ║  REVIEW  —  you, one key at a time       ║
    ║  [a] approve  [e] edit  [s] skip         ║
    ║  [r] reject with reason  [q] abort       ║
    ╚═══════════════════════╦══════════════════╝
                            │
                            ▼
                   .md  (append-only)
                 .index.json  (dedup hashes + rejection reasons)
```

**Why two stages:**

- Haiku is cheap and good at summarizing but mediocre at meta-judgment (is this evidence strong? is this category-fit? would this still be true in six months?). Running it alone means either low precision or over-conservative recall.
- Opus is expensive but stellar at the meta-layer, *especially* when the input is already-condensed candidates instead of 130K-token transcripts. Letting Haiku pre-digest the transcripts lets Opus spend all its effort on judgment.
- Splitting the roles lets each model do what it's good at. Result: 5–8× cheaper than a naive Opus-only pipeline and higher precision than a Haiku-only one.

**What Stage 2 actually checks**, per candidate (paraphrased from the prompt):

1. **Evidence quality.** Direct user quotes > user corrections > user framing choices > assistant actions. Inferred principles from assistant monologue are rejected.
2. **Category fit.** Did Stage 1 tag this for the right doc? Opus can reassign (e.g. move an item from `how-to-assume-with-me` to `what-i-care-about` if that's where it belongs).
3. **Principle vs mechanics.** Is this a durable preference, or a single-session task-specific decision dressed up as one?
4. **Null bias.** When in doubt, reject. The user loses ~5 seconds per false-reject; they lose more to pollution in their system prompt.
5. **Voice match.** Rewrite the content in the target doc's style before surfacing.
6. **Confidence recalibration.** Stage 1's `high` / `medium` / `low` can be overridden.

Typical outcomes: Stage 1 yields ~2–3 candidates per session; Stage 2 approves 20–50% of those. `/compound:last` shows you every rejection with reason.

---

## Flag reference

```
/compound                                    # default: --limit 5, all docs, gate on
/compound --since 7d                         # last 7 days (or: 24h, 48h, 14d, 1w)
/compound --since 2026-04-10                 # ISO date
/compound --limit 10                         # 10 most recent sessions
/compound --top 5                            # top 5 by message count (juicy sessions)
/compound --docs how-to-communicate,what-i-care-about
                                             # subset of docs (comma-separated)
/compound --sessions ~/path/to/session.jsonl,name-substring
                                             # specific sessions by path or substring match
/compound --dry-run                          # run pipeline, write logs, skip review
/compound --no-gate                          # skip Stage 2 (fast/cheap, noisier)
/compound --gate-model anthropic/claude-sonnet-4-5
                                             # override the gate model
```

Flags compose. `--top 3 --docs what-i-care-about --dry-run` is valid.

---

## Bringing your own context docs

If you already keep personal doctrine docs somewhere (`~/repos/HOW_TO_COMMUNICATE_WITH_ME.md`, dotfiles, etc.), symlink them into the compound dir rather than moving them:

```bash
ln -s ~/repos/HOW_TO_COMMUNICATE_WITH_ME.md \
      ~/.pi/agent/compound/how-to-communicate-with-me.md

ln -s ~/repos/HOW_TO_ASSUME_WITH_ME.md \
      ~/.pi/agent/compound/how-to-assume-with-me.md

ln -s ~/repos/WHAT_I_CARE_ABOUT.md \
      ~/.pi/agent/compound/what-i-care-about.md
```

Then drop a sidecar next to each symlink — copy one from `examples/` and tune `criteria:` to describe what belongs in *that specific* doc. Compound-managed docs and hand-maintained docs can coexist in the same directory; anything without a sidecar is invisible to `/compound`.

Your originals remain the source of truth. Appends happen through the symlink.

---

## Sidecar schema

Full field list. Only `purpose` and `criteria` are required.

```yaml
# Required.
purpose: >
  One paragraph: what this doc is for, what kind of items belong in it.

criteria: |
  Multi-line description of the signals in a session that should
  produce items for this doc. Be specific — this is the extractor's
  spec. Include explicit DO NOT clauses to keep categories disjoint
  from your other docs.

# Optional. How items should be formatted when added. Inlined into the prompt.
structure: |
  Short H2 sections. DO / DO NOT pairs where applicable.

# Optional. Helps the model match your voice.
style_examples:
  - |
    ## A complete example

    Showing the form, voice, and length you want.

# Optional. All fields default-sane.
scope:
  min_confidence: medium          # "low" | "medium" | "high" — min bar to surface
  max_proposals_per_run: 5        # per session (after Stage 1, before the gate)

# Optional. Override the Stage 1 model for this doc only.
# Stage 2 (the gate) is configured per-run via --gate-model.
model:
  provider: anthropic
  id: claude-sonnet-4-5
```

See the three examples in `examples/` for filled-out, field-tested sidecars.

---

## Dedup and session selection

**Dedup happens at two layers:**

1. **Hard dedup via content hash.** `.index.json` tracks the FNV hash of every approved and every rejected candidate per doc. The extractor sees this list and doesn't re-propose things you've already accepted or refused.
2. **Soft dedup via current doc body.** The extractor also reads the current body of each managed `.md` and is instructed to avoid re-proposing anything substantively covered there — even if *you* wrote it by hand.

**Your hand-edits are invisible to the index, and that's intentional.** You own the doc. If you want to delete something and have the pipeline propose it again later, just delete it; there's no hash record tying you to the past decision.

**Session selection** (for the `/compound` command itself):

- Default: 5 most recent sessions, across all cwds.
- `--since <spec>`: time window (`7d`, `48h`, ISO date).
- `--limit N`: most recent N.
- `--top N`: N sessions with highest message count (best for first runs — surfaces the dense sessions where preferences tend to get expressed).
- `--sessions <paths-or-substrings>`: specific sessions.
- Per-doc `last_run_at` is the default `--since` cutoff when no explicit window is given, so repeated runs don't re-chew sessions already seen.

---

## Cost and model configuration

Measured on real pi-effect-enforcer sessions (1600+ messages):

| Run shape | Stage 1 | Stage 2 | Total |
|---|---:|---:|---:|
| `--top 1` (1 session × 3 docs) | $0.17 | $0.02 | **$0.19** |
| `--top 3` (3 sessions × 3 docs) | $0.51 | $0.04 | **$0.55** |

Stage 1 scales with session size (one transcript read per session, regardless of doc count — all sidecars are passed in one prompt). Stage 2 scales with *candidate* count, not transcript size, which is why it stays cheap.

**Defaults:**
- Stage 1: `anthropic/claude-haiku-4-5`
- Stage 2: `anthropic/claude-opus-4-5`

**Overriding:**
- Per-doc Stage 1: set `model:` in the sidecar.
- Per-run Stage 2: `--gate-model provider/id`, or `--no-gate` to skip it entirely.

**Budgeting tip:** a weekly `/compound --since 7d` pass across ~5 sessions tends to run $0.50–$1.00. That's the *outer* cost bound because Stage 1 shrinks as `last_run_at` narrows the window.

---

## Design invariants

These are non-negotiable. The implementation preserves them explicitly:

1. **Append-only.** No removal, no rewrite. Your edits are authoritative.
2. **User-gated.** No proposal reaches a doc without a keypress. `--dry-run` exists for inspection.
3. **Evidence-grounded.** Every proposal cites a session path, a date, a cwd, and an evidence excerpt with role attribution.
4. **Dedup-aware.** Approved and rejected hashes are persisted; the extractor sees both before proposing.
5. **Doc-agnostic.** Zero hardcoded filenames or categories. Drop in `my-custom-category.md` + sidecar and `/compound` picks it up on next `/reload`.
6. **Read-only on sessions.** Nothing is ever written to `~/.pi/agent/sessions/`.
7. **Content docs ship pristine.** No frontmatter, no pipeline artifacts in the `.md`. The sidecar is a sibling file.

---

## FAQ

**Why two stages? Why not just a great prompt on one model?**
Been there. A single-model prompt that tries to do both coverage *and* judgment pulls in opposite directions: you either raise the bar and miss real signal, or lower it and drown in noise. Splitting the roles — Haiku casts wide, Opus applies strict standards — lets each prompt be tight and internally consistent. It's also significantly cheaper than running Opus over raw transcripts.

**Why not auto-approve `high`-confidence items?**
Because the confidence label is the *model's* self-assessment, and you're the one whose system prompt this goes into. The cost of a bad auto-approval is a stealth contamination of your prompt that's invisible until it starts causing weird behavior weeks later. The cost of a good manual approval is one keypress.

**Why not monitor sessions live and extract in real time?**
That's a different tool. Live monitors fight for attention during the work; retroactive extraction runs when you're ready to curate. Both are valid; this is the retroactive one. See [`pi-behavior-monitors`](https://github.com/davidorex/pi-behavior-monitors) for live-monitoring prior art.

**Can the pipeline propose entirely new docs, not just items in existing ones?**
Not directly — you create the `.md` + sidecar, the pipeline fills it in. But because the system is doc-agnostic, you *can* create something like `things-i-keep-wishing-i-had-a-doc-for.md` with criteria like *"moments where I wanted to drop a fact somewhere but no doc fit"* and let the pipeline propose to that meta-doc. The loop is open.

**What if I edit a doc by hand between runs?**
Fine. The extractor re-reads the full current body every run and dedupes against it. Your edits are invisible to the index (no hash record) so if you delete something, the pipeline is free to propose it again later.

**What if Stage 2 rejects something I wanted?**
Run `/compound:last` to see the stated reason. Three options: (a) live with it — the rejection is cached so it won't keep burning budget; (b) manually write the item into the doc — you own the file; (c) tune the sidecar's `criteria:` to make the case for this category of item more strongly, and re-run against the same session (dedup uses content hash, not criteria, so new wording gets a new chance).

**What if Stage 2 fails (API error, timeout)?**
Stage 1 candidates are converted to proposals directly with a warning banner. You still get the review queue, just without the gate filter.

**Can I use a different model for Stage 2?**
Yes: `/compound --gate-model anthropic/claude-sonnet-4-5` (or any pi-ai-supported `provider/id`). Sonnet is roughly 5× cheaper than Opus and does an acceptable job on most candidates, though Opus's meta-judgment is noticeably sharper.

**Does anything persist after `--dry-run`?**
Logs in `.log/` persist. No writes to `.index.json`, no writes to content docs.

---

## Non-goals

- **Not a live monitor.** No session interception, no continuous daemon.
- **Not agent-managed memory.** These docs are *yours*. They live in your system prompt, not in a vector store.
- **Not a schema-validated database.** Items are prose; the validator is you reading them.
- **Not automatic.** No cron, no auto-approve, no background jobs.
- **Not a framework.** One command, one extension file, no DSL, no workflow engine. Complexity lives in the prompts given to the two models — see `buildStage1Prompt` and `buildStage2Prompt` in `src/index.ts`.

---

## Contributing

PRs welcome. A few structural notes for contributors:

- The extension is a single file (`src/index.ts`, ~1700 LOC). Keep it single-file unless there's a strong reason to split.
- Prompt changes are the highest-leverage edits. If you're improving extraction quality, the first place to look is `buildStage1Prompt` and `buildStage2Prompt`.
- Test against real sessions: `pi -e . && /compound --top 1 --dry-run` and inspect `.log/run_*.json`.
- Typecheck clean: `bunx tsc --noEmit` (or `npx tsc --noEmit`).
- Keep the design invariants intact. If a change would weaken any of the 7, justify it in the PR.

---

## License

MIT © Marc Suesser. See [LICENSE](./LICENSE).
