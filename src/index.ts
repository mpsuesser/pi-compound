/**
 * pi-compound — monotonically compound value into your context docs from past Pi sessions.
 *
 * Commands registered:
 *   /compound          Run extraction → gate → review → append cycle.
 *   /compound:init     Scaffold ~/.pi/agent/compound/ with a starter doc + sidecar.
 *   /compound:status   Per-doc summary (last run, approved, rejected, queue).
 *   /compound:last     Render the most recent run (or a named one) with rejections + survivors.
 *   /compound:wire     Print the system-prompt include line for all managed docs.
 *
 * Layout:
 *   ~/.pi/agent/compound/
 *     foo.md                  ← user-owned content doc (ships to system prompt)
 *     foo.compound.yaml       ← sidecar with purpose + criteria + structure
 *     .index.json             ← machine-managed dedup + run history
 *     .log/                   ← per-run JSON logs (stage 1 candidates + stage 2 decisions)
 *
 * Pipeline (two-stage):
 *   1. Discover docs (foo.md + foo.compound.yaml pairs).
 *   2. Resolve session window (--since / --limit / --top / --sessions).
 *   3. STAGE 1 (Haiku, per session, batched across all docs):
 *      cast a wide net — one transcript read, candidates across all docs in one call.
 *   4. STAGE 2 (Opus, once per run, all candidates + all sidecars):
 *      apply nuanced judgment — filter, re-word, re-categorize, recalibrate confidence.
 *      This is where the meta-standards live (evidence quality, category fit,
 *      principles-vs-mechanics, null bias). Bypass with --no-gate to see raw output.
 *   5. Interactive review queue: approve / edit / skip / reject-with-reason.
 *      UI shows: doc, anchor, confidence, optional gate note, content. No evidence.
 *   6. Approved → append to doc + record in .index.json.
 *      Rejected → record reason in .index.json so future runs see it.
 *
 * Invariants:
 *   - Append-only: never modifies or removes existing doc content.
 *   - User-gated: nothing reaches the docs without an explicit keypress.
 *   - Read-only on ~/.pi/agent/sessions: the package never writes there.
 *   - Doc-agnostic: zero hardcoded filenames; works with 2 docs or 50.
 */

import { complete, type Api, type Message, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	serializeConversation,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// Container subclass that declares the optional Component.handleInput property,
// so TypeScript accepts dynamic assignment of an input handler at runtime.
class FocusContainer extends Container {
	handleInput?: (data: string) => void;
}

// Full-width horizontal rule. Auto-sizes to whatever width the TUI gives it.
class Divider {
	constructor(
		private readonly colorize: (text: string) => string,
		private readonly char = "\u2500",
		private readonly inset = 0,
	) {}
	render(width: number): string[] {
		const len = Math.max(4, width - this.inset * 2);
		return [" ".repeat(this.inset) + this.colorize(this.char.repeat(len))];
	}
	invalidate(): void {}
}

// ─── Paths ─────────────────────────────────────────────────────────────────

const COMPOUND_DIR = join(getAgentDir(), "compound");
const INDEX_PATH = join(COMPOUND_DIR, ".index.json");
const LOG_DIR = join(COMPOUND_DIR, ".log");
const SESSIONS_DIR = join(getAgentDir(), "sessions");

// ─── Defaults ──────────────────────────────────────────────────────────────

// Stage 1 — high-recall extraction (cheap, runs once per session, batched across all docs).
const DEFAULT_STAGE1_MODEL = { provider: "anthropic", id: "claude-haiku-4-5" } as const;
// Stage 2 — high-precision gate (premium reasoning model, runs once per run over all candidates).
// Falls back to the Stage 1 model if unavailable. Override via --gate-model provider/id.
const DEFAULT_GATE_MODEL = { provider: "anthropic", id: "claude-opus-4-5" } as const;
const DEFAULT_MIN_CONFIDENCE: Confidence = "medium";
const DEFAULT_MAX_PROPOSALS_PER_RUN = 5;
const DEFAULT_LIMIT_SESSIONS = 5;
// Cap transcript size sent to Stage 1. Haiku's context window is 200k; we reserve budget for
// the full sidecar block, instructions, and response. ~100k tokens of transcript content.
const MAX_TRANSCRIPT_CHARS = 400_000;

// ─── Types ─────────────────────────────────────────────────────────────────

type Confidence = "low" | "medium" | "high";

interface SidecarConfig {
	purpose: string;
	criteria: string;
	structure?: string;
	style_examples?: string[];
	scope?: {
		cwd_glob?: string | null;
		min_confidence?: Confidence;
		max_proposals_per_run?: number;
	};
	model?: { provider: string; id: string };
}

interface CompoundDoc {
	name: string;
	docPath: string;
	sidecarPath: string;
	body: string;
	config: SidecarConfig;
	sidecarRaw: string;
}

// Stage 1 output. Kept internal; goes into Stage 2 for filtering.
interface Candidate {
	candidateId: string; // `cand_<hex>`
	docName: string;
	sessionPath: string;
	sessionDate: string;
	sessionCwd: string;
	anchor: "append" | string;
	content: string;
	evidence: string; // used by the gate; NOT shown to the user
	confidence: Confidence;
}

// Stage 2 output (or raw Stage 1 when --no-gate): what the user reviews.
interface Proposal {
	id: string;
	docName: string;
	sessionPath: string;
	sessionDate: string;
	sessionCwd: string;
	anchor: "append" | string;
	content: string;
	evidence: string; // retained for the log; UI does not display it
	confidence: Confidence;
	gateNote?: string; // present when a gate approved this
	contentHash: string;
	proposedAt: string;
}

interface IndexEntry {
	last_run_at?: string;
	approved: Array<{ id: string; session: string; content_hash: string; added_at: string }>;
	rejected: Array<{ id: string; session: string; content_hash: string; reason: string; at: string }>;
	skipped: Array<{ id: string; at: string }>;
}

interface IndexFile {
	docs: Record<string, IndexEntry>;
	sessions_seen: Record<string, string>;
}

interface RunFlags {
	since?: string;
	limit?: number;
	top?: number;
	docs?: string[];
	sessions?: string[];
	dryRun: boolean;
	noGate?: boolean;
	gateModel?: { provider: string; id: string };
}

// ─── Filesystem helpers ────────────────────────────────────────────────────

function ensureCompoundDir(): void {
	if (!existsSync(COMPOUND_DIR)) mkdirSync(COMPOUND_DIR, { recursive: true });
	if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
	try {
		if (!existsSync(path)) return fallback;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function sha256Hex(input: string): string {
	// Small FNV-1a-ish hash, good enough for content identity dedup within a local store.
	let h1 = 0x811c9dc5 >>> 0;
	let h2 = 0xcbf29ce4 >>> 0;
	for (let i = 0; i < input.length; i++) {
		h1 = ((h1 ^ input.charCodeAt(i)) * 0x01000193) >>> 0;
		h2 = ((h2 ^ input.charCodeAt(input.length - 1 - i)) * 0x100000001b3) >>> 0;
	}
	return `fnv:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function shortId(prefix = "cmp"): string {
	const bytes = "abcdef0123456789";
	let s = "";
	for (let i = 0; i < 10; i++) s += bytes[Math.floor(Math.random() * 16)];
	return `${prefix}_${s}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeForHash(s: string): string {
	return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// ─── Discovery ─────────────────────────────────────────────────────────────

function loadSidecar(path: string): { config: SidecarConfig; raw: string } | null {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = parseYaml(raw) as Partial<SidecarConfig> | null;
		if (!parsed || typeof parsed !== "object") return null;
		if (!parsed.purpose || !parsed.criteria) return null;
		return {
			raw,
			config: {
				purpose: String(parsed.purpose),
				criteria: String(parsed.criteria),
				structure: parsed.structure ? String(parsed.structure) : undefined,
				style_examples: Array.isArray(parsed.style_examples) ? parsed.style_examples.map(String) : undefined,
				scope: parsed.scope as SidecarConfig["scope"],
				model: parsed.model,
			},
		};
	} catch {
		return null;
	}
}

function discoverDocs(): { docs: CompoundDoc[]; warnings: string[] } {
	const warnings: string[] = [];
	if (!existsSync(COMPOUND_DIR)) {
		return { docs: [], warnings: [`No compound directory at ${COMPOUND_DIR}. Run /compound:init.`] };
	}

	const entries = readdirSync(COMPOUND_DIR);
	const mdFiles = entries.filter((n) => n.endsWith(".md") && !n.startsWith("."));
	const docs: CompoundDoc[] = [];

	for (const md of mdFiles) {
		const name = md.slice(0, -3);
		const docPath = join(COMPOUND_DIR, md);
		const sidecarPath = join(COMPOUND_DIR, `${name}.compound.yaml`);
		if (!existsSync(sidecarPath)) {
			warnings.push(`${name}.md has no sidecar (${name}.compound.yaml) — ignored.`);
			continue;
		}
		const loaded = loadSidecar(sidecarPath);
		if (!loaded) {
			warnings.push(`${name}.compound.yaml is invalid (missing purpose or criteria) — ignored.`);
			continue;
		}
		const body = readFileSync(docPath, "utf-8");
		docs.push({ name, docPath, sidecarPath, body, config: loaded.config, sidecarRaw: loaded.raw });
	}

	return { docs, warnings };
}

// ─── Session enumeration ──────────────────────────────────────────────────

interface SessionMeta {
	path: string;
	startedAt: Date;
	cwd: string | null;
	messageCount: number;
}

function parseSessionFilenameTimestamp(name: string): Date | null {
	const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
	if (!m) return null;
	const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d : null;
}

function walkJsonlFiles(root: string): string[] {
	const out: string[] = [];
	if (!existsSync(root)) return out;
	const stack: string[] = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of entries) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) stack.push(full);
			else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(full);
		}
	}
	return out;
}

function quickSessionMeta(path: string): SessionMeta {
	const startedAt = parseSessionFilenameTimestamp(basename(path)) ?? new Date(statSync(path).mtimeMs);
	let cwd: string | null = null;
	let messageCount = 0;
	try {
		const content = readFileSync(path, "utf-8");
		for (const line of content.split("\n")) {
			if (!line) continue;
			try {
				const obj = JSON.parse(line);
				if (obj?.type === "session" && typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
				else if (obj?.type === "message") messageCount++;
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// skip
	}
	return { path, startedAt, cwd, messageCount };
}

function parseSinceClause(since: string): Date | null {
	const trimmed = since.trim();
	const rel = trimmed.match(/^(\d+)\s*([dwmh])$/i);
	if (rel) {
		const n = parseInt(rel[1], 10);
		const unit = rel[2].toLowerCase();
		const ms = unit === "h" ? 36e5 : unit === "d" ? 864e5 : unit === "w" ? 7 * 864e5 : 30 * 864e5;
		return new Date(Date.now() - n * ms);
	}
	const d = new Date(trimmed);
	return Number.isFinite(d.getTime()) ? d : null;
}

function selectSessions(flags: RunFlags, docName?: string, index?: IndexFile): SessionMeta[] {
	if (flags.sessions && flags.sessions.length > 0) {
		const all = walkJsonlFiles(SESSIONS_DIR);
		const out: SessionMeta[] = [];
		for (const ref of flags.sessions) {
			const direct = existsSync(ref) ? ref : null;
			const matched = direct ?? all.find((p) => basename(p).includes(ref) || p.endsWith(ref));
			if (matched) out.push(quickSessionMeta(matched));
		}
		return out;
	}

	const allPaths = walkJsonlFiles(SESSIONS_DIR);
	const metas = allPaths.map(quickSessionMeta).filter((m) => m.messageCount > 0);

	let cutoff: Date | null = null;
	if (flags.since) cutoff = parseSinceClause(flags.since);
	else if (docName && index?.docs[docName]?.last_run_at) cutoff = new Date(index.docs[docName].last_run_at!);

	let filtered = cutoff ? metas.filter((m) => m.startedAt >= cutoff!) : metas;
	filtered.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

	if (flags.top) {
		filtered = [...filtered].sort((a, b) => b.messageCount - a.messageCount).slice(0, flags.top);
	} else if (flags.limit) {
		filtered = filtered.slice(0, flags.limit);
	}

	return filtered;
}

// ─── Session loading ──────────────────────────────────────────────────────

function loadSessionTranscript(sessionPath: string, signal?: AbortSignal): { text: string; tokens: number } | null {
	try {
		const sm = SessionManager.open(sessionPath);
		const branch = sm.getBranch();
		const messages = branch
			.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
			.map((entry) => entry.message);
		if (messages.length === 0) return null;
		const llm = convertToLlm(messages);
		const text = serializeConversation(llm);
		void signal;
		return { text, tokens: Math.ceil(text.length / 4) };
	} catch {
		return null;
	}
}

function truncateTranscript(text: string): string {
	if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
	const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
	const omitted = text.length - MAX_TRANSCRIPT_CHARS;
	return text.slice(0, half) + `\n\n[... ${omitted} chars omitted ...]\n\n` + text.slice(-half);
}

// ─── Index store ──────────────────────────────────────────────────────────

function loadIndex(): IndexFile {
	return readJson<IndexFile>(INDEX_PATH, { docs: {}, sessions_seen: {} });
}

function getDocEntry(idx: IndexFile, docName: string): IndexEntry {
	if (!idx.docs[docName]) idx.docs[docName] = { approved: [], rejected: [], skipped: [] };
	return idx.docs[docName];
}

function saveIndex(idx: IndexFile): void {
	writeJson(INDEX_PATH, idx);
}

// ─── Prompt builders ──────────────────────────────────────────────────────

const STAGE1_SYSTEM_PROMPT = [
	"You are the Stage 1 extractor for pi-compound, a personal knowledge management system.",
	"You read ONE past Pi coding-agent session transcript and surface candidate additions for one or more user-owned documents in a single pass.",
	"A more capable model (the gate) filters and refines your candidates before the user sees them. Do not try to be perfect — surface plausible candidates and let the gate decide.",
	"You ALWAYS respond with valid JSON matching the requested schema. No other text. No markdown fences.",
].join(" ");

const STAGE2_SYSTEM_PROMPT = [
	"You are the final gate for pi-compound, a personal knowledge management system that accretes a user's durable preferences across multiple documents over time.",
	"An earlier pass surfaced candidate additions from session transcripts. Your job is to apply high standards before the user sees these — the user reviews every survivor one by one, so your precision matters more than your recall.",
	"You reply with ONE JSON object, no other text, no markdown fences.",
].join(" ");

function renderDocBlock(doc: CompoundDoc): string {
	return [
		`## doc: ${doc.name}`,
		"",
		"### sidecar (full)",
		"",
		"```yaml",
		doc.sidecarRaw.trim(),
		"```",
		"",
		"### current body",
		"",
		"```markdown",
		doc.body.trim() || "(empty)",
		"```",
	].join("\n");
}

function buildStage1Prompt(docs: CompoundDoc[], session: SessionMeta, transcript: string): string {
	const docBlocks = docs.map(renderDocBlock).join("\n\n---\n\n");
	const docNames = docs.map((d) => `"${d.name}"`).join(" | ");

	return [
		"# HOW THIS WORKS",
		"",
		"You read ONE session transcript. You surface candidate additions for any of the managed documents below. Tag every candidate with the single document it best fits. Full sidecars and current bodies are provided so you can judge category fit and avoid duplicating existing content.",
		"",
		"This is Stage 1 of a two-stage pipeline. A more capable model (the gate) will filter, possibly re-word, and possibly re-categorize your candidates. Do not aim for perfection — surface plausible candidates.",
		"",
		"Minimum discipline:",
		"- Every candidate references a specific moment in the transcript (verbatim user quotes are strongest evidence).",
		"- Tag every candidate with the single best-fitting document from the list.",
		"- Do not propose items already covered by the current body of the doc you're tagging.",
		"- Zero candidates is a perfectly fine answer when the session genuinely has nothing relevant.",
		"",
		"# MANAGED DOCUMENTS",
		"",
		docBlocks,
		"",
		"# SESSION",
		"",
		`Session file: ${session.path}`,
		`Started at: ${session.startedAt.toISOString()}`,
		`Cwd: ${session.cwd ?? "unknown"}`,
		`Message count: ${session.messageCount}`,
		"",
		"```transcript",
		transcript,
		"```",
		"",
		"# OUTPUT",
		"",
		"Return ONLY this JSON object. No other text. No markdown fences.",
		"",
		"{",
		'  "candidates": [',
		"    {",
		`      "docName": ${docNames},`,
		'      "anchor": "append" | "## Existing H2 Heading From That Doc\'s Body",',
		'      "content": "markdown to add — self-contained, includes any heading you want to introduce",',
		'      "evidence": "short excerpt from the transcript with role attribution, e.g. [user]: \\"stop telling me what you\'re about to do\\"",',
		'      "confidence": "low" | "medium" | "high"',
		"    }",
		"  ]",
		"}",
		"",
		'If nothing in the transcript is relevant to any document: { "candidates": [] }',
	].join("\n");
}

function buildStage2Prompt(docs: CompoundDoc[], candidates: Candidate[]): string {
	const docBlocks = docs.map(renderDocBlock).join("\n\n---\n\n");
	const candidatesJson = JSON.stringify(
		candidates.map((c) => ({
			candidateId: c.candidateId,
			docName: c.docName,
			anchor: c.anchor,
			content: c.content,
			evidence: c.evidence,
			confidence: c.confidence,
			sessionDate: c.sessionDate,
			sessionCwd: c.sessionCwd,
		})),
		null,
		2,
	);
	const docNames = docs.map((d) => `"${d.name}"`).join(" | ");

	return [
		"# YOUR STANDARDS",
		"",
		"**Category fit.** Each document has a precise purpose and criteria in its sidecar. A candidate must clearly belong to the document it's tagged for. If it fits a different managed document better, reassign it (and rewrite the content to match that doc's voice and structure). If it fits no document, reject.",
		"",
		"**Evidence quality.** The strongest candidates cite direct user statements (verbatim or close paraphrase). Candidates whose evidence is only an assistant action — describing what the agent did rather than what the user asked for — are weak inference chains and should usually be rejected, unless the assistant's action clearly mirrored explicit user direction you can point to in the same session.",
		"",
		"**Principles vs. mechanics.** Prefer items that reflect the user's beliefs, values, or enduring preferences. A refactor technique specific to one codebase is mechanics (reject, or rewrite to extract the underlying principle). A stated preference about a class of concern is a principle. Note: the user works in rapidly-evolving agentic development — some of their preferences are tied to the current state of tools and practices, and that's fine. What matters is that the item captures a belief or value, not an artifact of one refactor's mechanics.",
		"",
		"**Null bias.** Rejecting is the default; approving is the exception. Zero survivors is the expected common case when the candidates are weak. One well-calibrated survivor is worth more than five speculative approvals. Do not feel pressure to approve a quota.",
		"",
		"**Rewrite freely when approving.** You may rewrite the candidate's content to be more durable, more general, or better-matched to the target doc's voice. Strip project-specific names unless they are genuinely central. Match the style_examples in the target doc's sidecar.",
		"",
		"**Confidence calibration.** `high` = direct user quote and clear principled statement. `medium` = multiple user signals pointing the same way, or one strong explicit preference. `low` = single weak signal. Do not approve `low` unless the candidate is genuinely borderline and you think the user would want to see it anyway.",
		"",
		"# MANAGED DOCUMENTS",
		"",
		docBlocks,
		"",
		"# CANDIDATES TO JUDGE",
		"",
		"```json",
		candidatesJson,
		"```",
		"",
		"# OUTPUT",
		"",
		"Return ONLY this JSON object, no other text, no markdown fences. Every candidate MUST appear in either `approved` or `rejected` (by candidateId). Absence is not a vote.",
		"",
		"{",
		'  "approved": [',
		"    {",
		'      "candidateId": "cand_...",',
		`      "docName": ${docNames},`,
		'      "anchor": "append" | "## Existing H2 Heading From That Doc\'s Body",',
		'      "content": "markdown to add (possibly rewritten)",',
		'      "confidence": "medium" | "high",',
		'      "gateNote": "one sentence: why this survived, what it captures"',
		"    }",
		"  ],",
		'  "rejected": [',
		"    {",
		'      "candidateId": "cand_...",',
		'      "reason": "one sentence: category mismatch / weak evidence / project mechanics / duplicates body / etc"',
		"    }",
		"  ]",
		"}",
	].join("\n");
}

// ─── Extraction: Stage 1 (per-session, batched across docs) ───────────────

interface Stage1Result {
	sessionPath: string;
	candidates: Candidate[];
	tokensIn: number;
	cost: number;
	error?: string;
}

function parseJsonLoose(text: string): unknown {
	const stripped = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/i, "");
	return JSON.parse(stripped);
}

async function stage1ExtractFromSession(
	session: SessionMeta,
	docs: CompoundDoc[],
	model: Model<Api>,
	auth: { apiKey?: string; headers?: Record<string, string> },
	signal: AbortSignal,
): Promise<Stage1Result> {
	const transcript = loadSessionTranscript(session.path, signal);
	if (!transcript) {
		return { sessionPath: session.path, candidates: [], tokensIn: 0, cost: 0, error: "could not load transcript" };
	}

	const transcriptText = truncateTranscript(transcript.text);
	const promptText = buildStage1Prompt(docs, session, transcriptText);

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: promptText }],
		timestamp: Date.now(),
	};

	let response;
	try {
		response = await complete(
			model,
			{ systemPrompt: STAGE1_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
	} catch (err) {
		return {
			sessionPath: session.path,
			candidates: [],
			tokensIn: 0,
			cost: 0,
			error: `stage1 LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (response.stopReason === "aborted") {
		return { sessionPath: session.path, candidates: [], tokensIn: 0, cost: 0, error: "aborted" };
	}

	const responseText = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	let parsed: { candidates?: unknown };
	try {
		parsed = parseJsonLoose(responseText) as { candidates?: unknown };
	} catch (err) {
		return {
			sessionPath: session.path,
			candidates: [],
			tokensIn: response.usage?.totalTokens ?? 0,
			cost: response.usage?.cost?.total ?? 0,
			error: `stage1 response not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
	const validDocNames = new Set(docs.map((d) => d.name));
	const sessionDate = session.startedAt.toISOString().slice(0, 10);

	const candidates: Candidate[] = [];
	for (const raw of rawCandidates as unknown[]) {
		if (!raw || typeof raw !== "object") continue;
		const c = raw as Record<string, unknown>;
		const docName = typeof c.docName === "string" ? c.docName.trim() : "";
		if (!validDocNames.has(docName)) continue;
		const content = typeof c.content === "string" ? c.content.trim() : "";
		if (!content) continue;
		const evidence = typeof c.evidence === "string" ? c.evidence.trim() : "";
		const anchor = typeof c.anchor === "string" && c.anchor.trim() ? c.anchor.trim() : "append";
		const confidence: Confidence =
			c.confidence === "high" || c.confidence === "medium" || c.confidence === "low" ? c.confidence : "medium";

		candidates.push({
			candidateId: shortId("cand"),
			docName,
			sessionPath: session.path,
			sessionDate,
			sessionCwd: session.cwd ?? "unknown",
			anchor,
			content,
			evidence,
			confidence,
		});
	}

	return {
		sessionPath: session.path,
		candidates,
		tokensIn: response.usage?.totalTokens ?? 0,
		cost: response.usage?.cost?.total ?? 0,
	};
}

// ─── Extraction: Stage 2 (the gate, run once per invocation) ──────────────

interface Stage2Result {
	approved: Proposal[];
	rejections: Array<{ candidateId: string; reason: string }>;
	tokensIn: number;
	cost: number;
	error?: string;
}

async function stage2GateCandidates(
	candidates: Candidate[],
	docs: CompoundDoc[],
	index: IndexFile,
	model: Model<Api>,
	auth: { apiKey?: string; headers?: Record<string, string> },
	signal: AbortSignal,
): Promise<Stage2Result> {
	if (candidates.length === 0) {
		return { approved: [], rejections: [], tokensIn: 0, cost: 0 };
	}

	const promptText = buildStage2Prompt(docs, candidates);
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: promptText }],
		timestamp: Date.now(),
	};

	let response;
	try {
		response = await complete(
			model,
			{ systemPrompt: STAGE2_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
	} catch (err) {
		return {
			approved: [],
			rejections: [],
			tokensIn: 0,
			cost: 0,
			error: `stage2 LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (response.stopReason === "aborted") {
		return { approved: [], rejections: [], tokensIn: 0, cost: 0, error: "aborted" };
	}

	const responseText = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	let parsed: { approved?: unknown; rejected?: unknown };
	try {
		parsed = parseJsonLoose(responseText) as { approved?: unknown; rejected?: unknown };
	} catch (err) {
		return {
			approved: [],
			rejections: [],
			tokensIn: response.usage?.totalTokens ?? 0,
			cost: response.usage?.cost?.total ?? 0,
			error: `stage2 response not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const candidateById = new Map(candidates.map((c) => [c.candidateId, c]));
	const validDocNames = new Set(docs.map((d) => d.name));
	const confRank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
	const rawApproved = Array.isArray(parsed.approved) ? parsed.approved : [];
	const rawRejected = Array.isArray(parsed.rejected) ? parsed.rejected : [];

	const approved: Proposal[] = [];
	for (const raw of rawApproved as unknown[]) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		const candidateId = typeof r.candidateId === "string" ? r.candidateId : "";
		const cand = candidateById.get(candidateId);
		if (!cand) continue; // fabricated ids ignored

		const docName = typeof r.docName === "string" && validDocNames.has(r.docName) ? r.docName : cand.docName;
		const content = typeof r.content === "string" ? r.content.trim() : cand.content;
		if (!content) continue;
		const anchor = typeof r.anchor === "string" && r.anchor.trim() ? r.anchor.trim() : cand.anchor;
		const confidence: Confidence =
			r.confidence === "high" || r.confidence === "medium" || r.confidence === "low"
				? r.confidence
				: cand.confidence;
		const gateNote = typeof r.gateNote === "string" ? r.gateNote.trim() : undefined;

		const targetDoc = docs.find((d) => d.name === docName);
		const minConfidence = targetDoc?.config.scope?.min_confidence ?? DEFAULT_MIN_CONFIDENCE;
		if (confRank[confidence] < confRank[minConfidence]) continue;

		const docEntry = getDocEntry(index, docName);
		const knownHashes = new Set([
			...docEntry.approved.map((a) => a.content_hash),
			...docEntry.rejected.map((rr) => rr.content_hash),
		]);
		const contentHash = sha256Hex(normalizeForHash(content));
		if (knownHashes.has(contentHash)) continue;

		approved.push({
			id: shortId(),
			docName,
			sessionPath: cand.sessionPath,
			sessionDate: cand.sessionDate,
			sessionCwd: cand.sessionCwd,
			anchor,
			content,
			evidence: cand.evidence,
			confidence,
			gateNote,
			contentHash,
			proposedAt: nowIso(),
		});
	}

	const rejections: Array<{ candidateId: string; reason: string }> = [];
	for (const raw of rawRejected as unknown[]) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		const candidateId = typeof r.candidateId === "string" ? r.candidateId : "";
		if (!candidateById.has(candidateId)) continue;
		const reason = typeof r.reason === "string" ? r.reason.trim() : "(no reason)";
		rejections.push({ candidateId, reason });
	}

	return {
		approved,
		rejections,
		tokensIn: response.usage?.totalTokens ?? 0,
		cost: response.usage?.cost?.total ?? 0,
	};
}

// Fallback when --no-gate: convert raw Stage 1 candidates directly to Proposals,
// applying per-doc min_confidence and index-level dedup.
function candidatesToProposalsWithoutGate(
	candidates: Candidate[],
	docs: CompoundDoc[],
	index: IndexFile,
): Proposal[] {
	const confRank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
	const out: Proposal[] = [];
	for (const c of candidates) {
		const targetDoc = docs.find((d) => d.name === c.docName);
		const minConfidence = targetDoc?.config.scope?.min_confidence ?? DEFAULT_MIN_CONFIDENCE;
		if (confRank[c.confidence] < confRank[minConfidence]) continue;

		const docEntry = getDocEntry(index, c.docName);
		const knownHashes = new Set([
			...docEntry.approved.map((a) => a.content_hash),
			...docEntry.rejected.map((r) => r.content_hash),
		]);
		const contentHash = sha256Hex(normalizeForHash(c.content));
		if (knownHashes.has(contentHash)) continue;

		out.push({
			id: shortId(),
			docName: c.docName,
			sessionPath: c.sessionPath,
			sessionDate: c.sessionDate,
			sessionCwd: c.sessionCwd,
			anchor: c.anchor,
			content: c.content,
			evidence: c.evidence,
			confidence: c.confidence,
			contentHash,
			proposedAt: nowIso(),
		});
	}
	return out;
}

// ─── Append logic ─────────────────────────────────────────────────────────

function appendProposalToDoc(doc: CompoundDoc, proposal: Proposal): void {
	const current = readFileSync(doc.docPath, "utf-8");
	let updated: string;

	if (proposal.anchor === "append") {
		const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
		updated = current + sep + proposal.content.trim() + "\n";
	} else {
		const heading = proposal.anchor.startsWith("#") ? proposal.anchor : `## ${proposal.anchor}`;
		const lines = current.split("\n");
		const idx = lines.findIndex((l) => l.trim() === heading.trim());
		if (idx === -1) {
			const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
			updated = current + sep + proposal.content.trim() + "\n";
		} else {
			let next = idx + 1;
			while (next < lines.length && !/^##\s/.test(lines[next])) next++;
			const before = lines.slice(0, next).join("\n");
			const after = lines.slice(next).join("\n");
			const insertion = "\n" + proposal.content.trim() + "\n\n";
			updated = before + insertion + after;
		}
	}

	writeFileSync(doc.docPath, updated, "utf-8");
}

// ─── Review UI ────────────────────────────────────────────────────────────

type ReviewDecision = "approve" | "reject" | "skip" | "abort";

interface ReviewOutcome {
	decision: ReviewDecision;
	rejectReason?: string;
}

type ThemeColorName = Parameters<Theme["fg"]>[0];

// Pretty, aligned key:value row for the proposal metadata block.
function metaLine(
	theme: Theme,
	key: string,
	value: string,
	opts?: { valueColor?: ThemeColorName; keyWidth?: number },
): Text {
	const keyWidth = opts?.keyWidth ?? 12;
	const k = theme.fg("muted", key.padEnd(keyWidth));
	const v = opts?.valueColor ? theme.fg(opts.valueColor, value) : value;
	return new Text("  " + k + v, 0, 0);
}

// Wrap a long string at wordish boundaries, emitting continuation lines indented
// to align with the value column. Keeps long gateNotes from blowing out one line.
function metaLinesWrapped(
	theme: Theme,
	key: string,
	value: string,
	maxValueWidth: number,
	opts?: { valueColor?: ThemeColorName; keyWidth?: number },
): Text[] {
	const keyWidth = opts?.keyWidth ?? 12;
	const indent = "  " + " ".repeat(keyWidth);
	const words = value.split(/\s+/);
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		if (cur.length + 1 + w.length > maxValueWidth && cur) {
			lines.push(cur);
			cur = w;
		} else {
			cur = cur ? cur + " " + w : w;
		}
	}
	if (cur) lines.push(cur);
	if (lines.length === 0) lines.push("");

	const out: Text[] = [];
	out.push(metaLine(theme, key, lines[0], opts));
	for (let i = 1; i < lines.length; i++) {
		const v = opts?.valueColor ? theme.fg(opts.valueColor, lines[i]) : lines[i];
		out.push(new Text(indent + v, 0, 0));
	}
	return out;
}

async function reviewProposalUI(
	ctx: ExtensionCommandContext,
	proposal: Proposal,
	docBody: string,
	indexInfo: { current: number; total: number },
): Promise<ReviewOutcome> {
	void docBody;
	return new Promise((resolve) => {
		void ctx.ui.custom<ReviewOutcome>((tui, theme, _kb, done) => {
			const container = new FocusContainer();

			const confColor: ThemeColorName | undefined =
				proposal.confidence === "high"
					? "accent"
					: proposal.confidence === "low"
						? "warning"
						: undefined;

			const cwdDisplay =
				proposal.sessionCwd === "unknown"
					? "?"
					: proposal.sessionCwd.replace(process.env.HOME ?? "", "~");

			const counter = new Text(
				theme.fg("muted", `  Proposal ${indexInfo.current} of ${indexInfo.total}`),
				0,
				0,
			);

			const docHeader = new Text("  " + theme.bold(theme.fg("accent", proposal.docName)), 0, 0);

			const anchor = metaLine(theme, "anchor", proposal.anchor);
			const confidence = metaLine(theme, "confidence", proposal.confidence, { valueColor: confColor });
			const from = metaLine(theme, "from", `${proposal.sessionDate}  ${cwdDisplay}`);

			const proposalContent = new Markdown(proposal.content, 0, 0, getMarkdownTheme());

			const dividerMuted = new Divider((t) => theme.fg("muted", t), "\u2500", 2);
			const dividerFaint = new Divider((t) => theme.fg("muted", t), "\u2500", 2);

			const help = new Text(
				theme.fg(
					"muted",
					"  [a] approve    [e] edit then approve    [s] skip    [r] reject with reason    [q] abort",
				),
				0,
				0,
			);

			container.addChild(new Spacer(1));
			container.addChild(counter);
			container.addChild(docHeader);
			container.addChild(new Spacer(1));
			container.addChild(anchor);
			container.addChild(confidence);
			container.addChild(from);
			if (proposal.gateNote) {
				for (const line of metaLinesWrapped(theme, "gate", proposal.gateNote, 80)) {
					container.addChild(line);
				}
			}
			container.addChild(new Spacer(1));
			container.addChild(dividerMuted);
			container.addChild(new Spacer(1));
			container.addChild(proposalContent);
			container.addChild(new Spacer(1));
			container.addChild(dividerFaint);
			container.addChild(new Spacer(1));
			container.addChild(help);
			container.addChild(new Spacer(1));

			container.handleInput = async (data: string) => {
				const k = data.toLowerCase();
				if (k === "a") {
					done({ decision: "approve" });
					resolve({ decision: "approve" });
				} else if (k === "s") {
					done({ decision: "skip" });
					resolve({ decision: "skip" });
				} else if (k === "q" || data === "\x1b" || data === "\x03") {
					done({ decision: "abort" });
					resolve({ decision: "abort" });
				} else if (k === "r") {
					const reason = await ctx.ui.editor("Reason for rejecting this proposal", "");
					done({ decision: "reject", rejectReason: reason ?? "(no reason given)" });
					resolve({ decision: "reject", rejectReason: reason ?? "(no reason given)" });
				} else if (k === "e") {
					const edited = await ctx.ui.editor("Edit the proposal content before approving", proposal.content);
					if (edited === undefined || edited.trim().length === 0) {
						tui.requestRender();
						return;
					}
					proposal.content = edited;
					proposal.contentHash = sha256Hex(normalizeForHash(edited));
					done({ decision: "approve" });
					resolve({ decision: "approve" });
				}
			};

			return container;
		});
	});
}

// ─── Argument parsing ─────────────────────────────────────────────────────

function parseFlags(args: string): RunFlags {
	const flags: RunFlags = { dryRun: false };
	const tokens = args.split(/\s+/).filter(Boolean);

	const parseModelSpec = (s: string): { provider: string; id: string } | undefined => {
		const slash = s.indexOf("/");
		if (slash === -1) return undefined;
		return { provider: s.slice(0, slash), id: s.slice(slash + 1) };
	};

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "--dry-run") flags.dryRun = true;
		else if (tok === "--no-gate") flags.noGate = true;
		else if (tok === "--since" && tokens[i + 1]) flags.since = tokens[++i];
		else if (tok.startsWith("--since=")) flags.since = tok.slice("--since=".length);
		else if (tok === "--limit" && tokens[i + 1]) flags.limit = parseInt(tokens[++i], 10);
		else if (tok.startsWith("--limit=")) flags.limit = parseInt(tok.slice("--limit=".length), 10);
		else if (tok === "--top" && tokens[i + 1]) flags.top = parseInt(tokens[++i], 10);
		else if (tok.startsWith("--top=")) flags.top = parseInt(tok.slice("--top=".length), 10);
		else if (tok === "--docs" && tokens[i + 1]) flags.docs = tokens[++i].split(",").map((s) => s.trim());
		else if (tok.startsWith("--docs="))
			flags.docs = tok.slice("--docs=".length).split(",").map((s) => s.trim());
		else if (tok === "--sessions" && tokens[i + 1])
			flags.sessions = tokens[++i].split(",").map((s) => s.trim());
		else if (tok.startsWith("--sessions="))
			flags.sessions = tok.slice("--sessions=".length).split(",").map((s) => s.trim());
		else if (tok === "--gate-model" && tokens[i + 1]) flags.gateModel = parseModelSpec(tokens[++i]);
		else if (tok.startsWith("--gate-model=")) flags.gateModel = parseModelSpec(tok.slice("--gate-model=".length));
	}
	return flags;
}

// ─── Model resolution ─────────────────────────────────────────────────────

function resolveStage1Model(ctx: ExtensionCommandContext, docs: CompoundDoc[]): Model<Api> | undefined {
	for (const d of docs) {
		if (d.config.model) {
			const m = ctx.modelRegistry.find(d.config.model.provider, d.config.model.id);
			if (m) return m;
		}
	}
	const def = ctx.modelRegistry.find(DEFAULT_STAGE1_MODEL.provider, DEFAULT_STAGE1_MODEL.id);
	if (def) return def;
	return ctx.model;
}

function resolveGateModel(
	ctx: ExtensionCommandContext,
	flags: RunFlags,
	stage1Fallback: Model<Api>,
): { model: Model<Api>; usedFallback: boolean; requested: { provider: string; id: string } } {
	const requested = flags.gateModel ?? DEFAULT_GATE_MODEL;
	const found = ctx.modelRegistry.find(requested.provider, requested.id);
	if (found) return { model: found, usedFallback: false, requested };
	return { model: stage1Fallback, usedFallback: true, requested };
}

function setLoaderMessage(loader: BorderedLoader, message: string): void {
	const inner = (loader as unknown as { loader?: { setMessage?: (m: string) => void } }).loader;
	inner?.setMessage?.(message);
}

// ─── Main /compound command ───────────────────────────────────────────────

async function runCompound(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/compound requires interactive mode", "error");
		return;
	}

	ensureCompoundDir();

	const { docs, warnings } = discoverDocs();
	for (const w of warnings) ctx.ui.notify(w, "warning");

	if (docs.length === 0) {
		ctx.ui.notify(`No managed docs found in ${COMPOUND_DIR}. Run /compound:init.`, "warning");
		return;
	}

	const flags = parseFlags(args);
	const selectedDocs = flags.docs ? docs.filter((d) => flags.docs!.includes(d.name)) : docs;
	if (selectedDocs.length === 0) {
		ctx.ui.notify(`No docs match --docs filter: ${flags.docs?.join(",") ?? ""}`, "error");
		return;
	}

	if (!flags.since && !flags.limit && !flags.top && !flags.sessions) {
		flags.limit = DEFAULT_LIMIT_SESSIONS;
	}

	const index = loadIndex();

	// Session selection: union across selectedDocs (each may have its own last_run_at cutoff).
	const sessionMap = new Map<string, SessionMeta>();
	for (const doc of selectedDocs) {
		for (const s of selectSessions(flags, doc.name, index)) sessionMap.set(s.path, s);
	}
	const sessions = [...sessionMap.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

	if (sessions.length === 0) {
		ctx.ui.notify("No sessions matched the selection criteria.", "info");
		return;
	}

	const stage1Model = resolveStage1Model(ctx, selectedDocs);
	if (!stage1Model) {
		ctx.ui.notify(
			`No model available. Default stage1 is ${DEFAULT_STAGE1_MODEL.provider}/${DEFAULT_STAGE1_MODEL.id}; configure API keys or override via sidecar.`,
			"error",
		);
		return;
	}

	const stage1Auth = await ctx.modelRegistry.getApiKeyAndHeaders(stage1Model);
	if (!stage1Auth.ok) {
		ctx.ui.notify(`Auth failed for ${stage1Model.provider}/${stage1Model.id}: ${stage1Auth.error}`, "error");
		return;
	}

	const useGate = !flags.noGate;
	const gate = useGate ? resolveGateModel(ctx, flags, stage1Model) : null;
	const gateAuth = gate ? await ctx.modelRegistry.getApiKeyAndHeaders(gate.model) : null;
	if (gate && gateAuth && !gateAuth.ok) {
		ctx.ui.notify(
			`Gate auth failed for ${gate.model.provider}/${gate.model.id}: ${gateAuth.error}. Running without gate.`,
			"warning",
		);
	}

	// ── Phase 1: Stage 1 extraction over all sessions ─────────────────────

	const stage1Results: Stage1Result[] = [];
	const allCandidates: Candidate[] = [];
	let stage1Cost = 0;
	let stage1Tokens = 0;

	const stage1Done = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		void tui;
		void theme;
		const loader = new BorderedLoader(
			tui,
			theme,
			`Stage 1 extraction over ${sessions.length} session${sessions.length === 1 ? "" : "s"} × ${selectedDocs.length} doc${selectedDocs.length === 1 ? "" : "s"} using ${stage1Model.id}…`,
		);
		const localSignal = new AbortController();
		loader.onAbort = () => {
			localSignal.abort();
			done(false);
		};

		(async () => {
			for (let i = 0; i < sessions.length; i++) {
				if (localSignal.signal.aborted) break;
				const s = sessions[i];
				setLoaderMessage(
					loader,
					`Stage 1 (${i + 1}/${sessions.length}) · ${basename(s.path).slice(0, 28)}…`,
				);
				const result = await stage1ExtractFromSession(
					s,
					selectedDocs,
					stage1Model,
					{ apiKey: stage1Auth.apiKey, headers: stage1Auth.headers },
					localSignal.signal,
				);
				stage1Results.push(result);
				stage1Cost += result.cost;
				stage1Tokens += result.tokensIn;
				for (const c of result.candidates) allCandidates.push(c);
			}
			done(true);
		})();

		return loader;
	});

	if (!stage1Done) {
		ctx.ui.notify("Stage 1 aborted.", "info");
		return;
	}

	// ── Phase 2: Stage 2 gate (or --no-gate fallback) ─────────────────────

	let finalProposals: Proposal[] = [];
	let stage2: Stage2Result = { approved: [], rejections: [], tokensIn: 0, cost: 0 };
	let gateAttempted = false;

	if (useGate && gate && gateAuth && gateAuth.ok && allCandidates.length > 0) {
		gateAttempted = true;
		const gateResult = await ctx.ui.custom<Stage2Result | null>((tui, theme, _kb, done) => {
			void tui;
			void theme;
			const loader = new BorderedLoader(
				tui,
				theme,
				`Stage 2 gate over ${allCandidates.length} candidate${allCandidates.length === 1 ? "" : "s"} using ${gate.model.id}${gate.usedFallback ? " (fallback — gate unavailable)" : ""}…`,
			);
			const localSignal = new AbortController();
			loader.onAbort = () => {
				localSignal.abort();
				done(null);
			};

			(async () => {
				const r = await stage2GateCandidates(
					allCandidates,
					selectedDocs,
					index,
					gate.model,
					{ apiKey: gateAuth.apiKey, headers: gateAuth.headers },
					localSignal.signal,
				);
				done(r);
			})();

			return loader;
		});

		if (gateResult) {
			stage2 = gateResult;
			finalProposals = gateResult.approved;
		}
	}

	// Fall back to raw Stage 1 candidates if gate was bypassed or failed.
	if (!useGate || !gateAttempted || stage2.error) {
		if (stage2.error) {
			ctx.ui.notify(`Gate error: ${stage2.error}. Falling back to raw Stage 1 candidates.`, "warning");
		}
		finalProposals = candidatesToProposalsWithoutGate(allCandidates, selectedDocs, index);
	}

	// ── Phase 3: Logs and index update ────────────────────────────────────

	const totalCost = stage1Cost + stage2.cost;
	const totalTokens = stage1Tokens + stage2.tokensIn;
	const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;

	writeJson(join(LOG_DIR, `${runId}.json`), {
		runId,
		ranAt: nowIso(),
		flags,
		stage1Model: { provider: stage1Model.provider, id: stage1Model.id },
		gateModel: gate ? { provider: gate.model.provider, id: gate.model.id, fallback: gate.usedFallback } : null,
		sessionCount: sessions.length,
		docCount: selectedDocs.length,
		stage1: {
			candidateCount: allCandidates.length,
			tokens: stage1Tokens,
			cost: stage1Cost,
			errors: stage1Results.filter((r) => r.error).map((r) => ({ session: r.sessionPath, error: r.error })),
		},
		stage2: useGate
			? {
					ran: gateAttempted,
					approvedCount: stage2.approved.length,
					rejectedCount: stage2.rejections.length,
					tokens: stage2.tokensIn,
					cost: stage2.cost,
					error: stage2.error,
					rejections: stage2.rejections,
				}
			: { ran: false, reason: "--no-gate" },
		finalProposalCount: finalProposals.length,
		totalCost,
		totalTokens,
	});

	// Log candidates + proposals for inspection
	writeJson(join(LOG_DIR, `${runId}.candidates.json`), allCandidates);
	writeJson(join(LOG_DIR, `${runId}.proposals.json`), finalProposals);

	for (const s of sessions) index.sessions_seen[s.path] = nowIso();

	if (finalProposals.length === 0) {
		const stage1Errors = stage1Results.filter((r) => r.error).length;
		ctx.ui.notify(
			`Stage 1: ${allCandidates.length} candidates. ${useGate && gateAttempted ? `Gate rejected ${stage2.rejections.length}.` : ""}${stage1Errors > 0 ? ` ${stage1Errors} stage1 errors.` : ""} Cost: $${totalCost.toFixed(4)}. Log: ${join(LOG_DIR, `${runId}.json`)}`,
			"info",
		);
		for (const doc of selectedDocs) getDocEntry(index, doc.name).last_run_at = nowIso();
		saveIndex(index);
		return;
	}

	// ── Phase 4: Dry run or review queue ──────────────────────────────────

	if (flags.dryRun) {
		ctx.ui.notify(
			`Dry run: ${finalProposals.length} proposal(s) after gate. Stage1 $${stage1Cost.toFixed(4)} + Stage2 $${stage2.cost.toFixed(4)} = $${totalCost.toFixed(4)}. Log: ${join(LOG_DIR, `${runId}.json`)}`,
			"info",
		);
		return;
	}

	let approvedCount = 0;
	let rejectedCount = 0;
	let skippedCount = 0;

	for (let i = 0; i < finalProposals.length; i++) {
		const proposal = finalProposals[i];
		const doc = selectedDocs.find((d) => d.name === proposal.docName)!;
		const outcome = await reviewProposalUI(ctx, proposal, doc.body, {
			current: i + 1,
			total: finalProposals.length,
		});

		if (outcome.decision === "abort") break;

		const docEntry = getDocEntry(index, doc.name);
		if (outcome.decision === "approve") {
			appendProposalToDoc(doc, proposal);
			docEntry.approved.push({
				id: proposal.id,
				session: proposal.sessionPath,
				content_hash: proposal.contentHash,
				added_at: nowIso(),
			});
			approvedCount++;
		} else if (outcome.decision === "reject") {
			docEntry.rejected.push({
				id: proposal.id,
				session: proposal.sessionPath,
				content_hash: proposal.contentHash,
				reason: outcome.rejectReason ?? "(no reason)",
				at: nowIso(),
			});
			rejectedCount++;
		} else if (outcome.decision === "skip") {
			docEntry.skipped.push({ id: proposal.id, at: nowIso() });
			skippedCount++;
		}
	}

	for (const doc of selectedDocs) getDocEntry(index, doc.name).last_run_at = nowIso();
	saveIndex(index);

	ctx.ui.notify(
		`Review done. Approved: ${approvedCount}, rejected: ${rejectedCount}, skipped: ${skippedCount}. Cost: $${totalCost.toFixed(4)}.`,
		"info",
	);
}

// ─── /compound:init ───────────────────────────────────────────────────────

const STARTER_DOC = `# What I Care About

This document captures things I care about — preferences, principles, recurring concerns —
that the agent should treat as durable context across sessions.

(Your first run of \`/compound\` will start populating this from past sessions.)
`;

const STARTER_SIDECAR = `# Sidecar for what-i-care-about.md
# Consumed by pi-compound. The .md file ships to your Pi system prompt as-is.

purpose: >
  Things I care about — durable preferences, recurring concerns, principles I
  return to. The kind of context I want every Pi session to have about me
  without me having to repeat it.

criteria: |
  Propose an item when, in a Pi session, I:
  - express a recurring preference, principle, or concern
  - return to the same topic across multiple turns or sessions
  - explicitly state "I care about X" or "what matters to me is Y"
  - reject something with a principled reason (not just a one-off correction)

  DO NOT propose:
  - one-off task instructions
  - communication style preferences (those go in how-to-communicate-with-me)
  - technical assumptions (those go in how-to-assume-with-me)

structure: |
  Short H2 sections. Each section opens with the principle stated plainly,
  followed by 1-3 sentences of nuance. Imperative voice. No hedging.

scope:
  min_confidence: medium
  max_proposals_per_run: 5
`;

async function runInit(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	ensureCompoundDir();
	const docPath = join(COMPOUND_DIR, "what-i-care-about.md");
	const sidecarPath = join(COMPOUND_DIR, "what-i-care-about.compound.yaml");

	let created = 0;
	if (!existsSync(docPath)) {
		writeFileSync(docPath, STARTER_DOC, "utf-8");
		created++;
	}
	if (!existsSync(sidecarPath)) {
		writeFileSync(sidecarPath, STARTER_SIDECAR, "utf-8");
		created++;
	}

	ctx.ui.notify(
		created === 0
			? `Compound dir already initialized at ${COMPOUND_DIR}.`
			: `Initialized ${COMPOUND_DIR} (${created} file${created === 1 ? "" : "s"} created).`,
		"info",
	);
}

// ─── /compound:status ─────────────────────────────────────────────────────

async function runStatus(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	ensureCompoundDir();
	const { docs } = discoverDocs();
	const index = loadIndex();

	const lines: string[] = [];
	lines.push(`# pi-compound status`);
	lines.push(``);
	lines.push(`Compound dir: \`${COMPOUND_DIR}\``);
	lines.push(`Docs discovered: ${docs.length}`);
	lines.push(`Sessions root: \`${SESSIONS_DIR}\``);
	lines.push(``);

	if (docs.length === 0) {
		lines.push(`(no managed docs — run \`/compound:init\` to scaffold one)`);
	} else {
		lines.push(`| doc | last run | approved | rejected | skipped |`);
		lines.push(`| --- | --- | ---: | ---: | ---: |`);
		for (const d of docs) {
			const e = index.docs[d.name];
			const last = e?.last_run_at ? new Date(e.last_run_at).toISOString().slice(0, 16).replace("T", " ") : "—";
			lines.push(
				`| \`${d.name}\` | ${last} | ${e?.approved.length ?? 0} | ${e?.rejected.length ?? 0} | ${e?.skipped.length ?? 0} |`,
			);
		}
	}

	const recentLogs = existsSync(LOG_DIR)
		? readdirSync(LOG_DIR)
				.filter((n) => n.endsWith(".json") && !n.endsWith(".proposals.json") && !n.endsWith(".candidates.json"))
				.sort()
				.slice(-3)
		: [];
	if (recentLogs.length > 0) {
		lines.push(``);
		lines.push(`Recent runs:`);
		for (const log of recentLogs) lines.push(`- \`${join(LOG_DIR, log)}\``);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

// ─── /compound:wire ───────────────────────────────────────────────────────

interface RunSummary {
	runId?: string;
	ranAt?: string;
	flags?: RunFlags;
	stage1Model?: { provider?: string; id?: string };
	gateModel?: { provider?: string; id?: string; fallback?: boolean } | null;
	sessionCount?: number;
	docCount?: number;
	stage1?: {
		candidateCount?: number;
		tokens?: number;
		cost?: number;
		errors?: Array<{ session?: string; error?: string }>;
	};
	stage2?: {
		ran?: boolean;
		approvedCount?: number;
		rejectedCount?: number;
		tokens?: number;
		cost?: number;
		error?: string;
		reason?: string;
		rejections?: Array<{ candidateId: string; reason: string }>;
	};
	finalProposalCount?: number;
	totalCost?: number;
	totalTokens?: number;
}

function truncateMarkdownPreview(content: string, maxLines = 8): string {
	const lines = content.split("\n");
	if (lines.length <= maxLines) return content.trim();
	return lines.slice(0, maxLines).join("\n").trim() + `\n\n_(+${lines.length - maxLines} more lines)_`;
}

async function runLast(args: string, ctx: ExtensionCommandContext): Promise<void> {
	ensureCompoundDir();
	if (!existsSync(LOG_DIR)) {
		ctx.ui.notify("No runs yet.", "info");
		return;
	}

	const logs = readdirSync(LOG_DIR)
		.filter(
			(n) =>
				n.startsWith("run_") &&
				n.endsWith(".json") &&
				!n.endsWith(".proposals.json") &&
				!n.endsWith(".candidates.json"),
		)
		.sort();

	if (logs.length === 0) {
		ctx.ui.notify("No runs yet.", "info");
		return;
	}

	// Optional arg: substring of a run filename to render that run instead of the most recent.
	const selector = args.trim();
	const chosenName = selector
		? (logs.slice().reverse().find((n) => n.includes(selector)) ?? logs[logs.length - 1])
		: logs[logs.length - 1];

	const runIdBase = chosenName.slice(0, -".json".length);
	const summaryPath = join(LOG_DIR, chosenName);
	const candidatesPath = join(LOG_DIR, `${runIdBase}.candidates.json`);
	const proposalsPath = join(LOG_DIR, `${runIdBase}.proposals.json`);

	const summary = readJson<RunSummary | null>(summaryPath, null);
	if (!summary) {
		ctx.ui.notify(`Could not read ${summaryPath}`, "error");
		return;
	}
	const candidates = readJson<Candidate[]>(candidatesPath, []);
	const proposals = readJson<Proposal[]>(proposalsPath, []);
	const candById = new Map(candidates.map((c) => [c.candidateId, c]));

	const out: string[] = [];
	const ranAt = summary.ranAt
		? new Date(summary.ranAt).toISOString().slice(0, 16).replace("T", " ")
		: "?";
	const totalCost = summary.totalCost ?? 0;
	const stage1Cost = summary.stage1?.cost ?? 0;
	const stage2Cost = summary.stage2?.cost ?? 0;

	const flagStr =
		Object.entries(summary.flags ?? {})
			.filter(([, v]) => v !== undefined && v !== false)
			.map(([k, v]) => (v === true ? `--${k}` : `--${k}=${Array.isArray(v) ? v.join(",") : v}`))
			.join(" ") || "(defaults)";

	out.push(`# pi-compound — last run`);
	out.push(``);
	out.push(`**Ran:** ${ranAt}  ·  **flags:** \`${flagStr}\``);
	out.push(
		`**Cost:** $${totalCost.toFixed(4)}  (Stage 1 $${stage1Cost.toFixed(4)} · Stage 2 $${stage2Cost.toFixed(4)})`,
	);
	out.push(`**Sessions:** ${summary.sessionCount ?? "?"}  ·  **Docs:** ${summary.docCount ?? "?"}`);
	out.push(``);

	const s1Model = summary.stage1Model?.id ?? "?";
	out.push(`## Stage 1 — \`${s1Model}\``);
	out.push(`Candidates: **${summary.stage1?.candidateCount ?? 0}**`);
	const s1errors = summary.stage1?.errors ?? [];
	if (s1errors.length > 0) {
		out.push(``);
		out.push(`Errors:`);
		for (const e of s1errors) out.push(`- \`${basename(e.session ?? "?")}\`: ${e.error}`);
	}
	out.push(``);

	const s2 = summary.stage2;
	if (s2?.ran) {
		const gateModel = summary.gateModel?.id ?? "?";
		const fallbackNote = summary.gateModel?.fallback ? " _(fallback)_" : "";
		out.push(`## Stage 2 — \`${gateModel}\`${fallbackNote}`);
		out.push(
			`Approved: **${s2.approvedCount ?? 0}**  ·  Rejected: **${s2.rejectedCount ?? 0}**`,
		);
		if (s2.error) out.push(`_Error:_ ${s2.error}`);

		const rejections = s2.rejections ?? [];
		if (rejections.length > 0) {
			out.push(``);
			out.push(`### Rejections`);
			out.push(``);
			for (let i = 0; i < rejections.length; i++) {
				const rej = rejections[i];
				const cand = candById.get(rej.candidateId);
				const docLabel = cand?.docName ? `\`${cand.docName}\`` : "`?`";
				const confLabel = cand?.confidence ? `conf=${cand.confidence}` : "";
				const sessionLabel = cand
					? `${cand.sessionDate} · ${cand.sessionCwd.replace(process.env.HOME ?? "", "~")}`
					: "";
				out.push(`**${i + 1}.** ${docLabel}  _${confLabel}_  \`${rej.candidateId}\``);
				if (sessionLabel) out.push(`_from:_ ${sessionLabel}`);
				out.push(``);
				out.push(`_reason:_ ${rej.reason}`);
				if (cand) {
					const preview = truncateMarkdownPreview(cand.content, 8)
						.split("\n")
						.map((l) => `> ${l}`)
						.join("\n");
					out.push(``);
					out.push(preview);
				}
				out.push(``);
			}
		}
	} else if (summary.stage2) {
		out.push(`## Stage 2 — skipped`);
		out.push(`_(${s2?.reason ?? "not run"})_`);
		out.push(``);
	}

	if (proposals.length > 0) {
		out.push(`## Proposals surfaced for review (${proposals.length})`);
		out.push(``);
		for (let i = 0; i < proposals.length; i++) {
			const p = proposals[i];
			out.push(`**${i + 1}.** \`${p.docName}\`  _conf=${p.confidence}_  anchor=\`${p.anchor}\``);
			if (p.gateNote) out.push(`_gate:_ ${p.gateNote}`);
			out.push(``);
			const preview = truncateMarkdownPreview(p.content, 8)
				.split("\n")
				.map((l) => `> ${l}`)
				.join("\n");
			out.push(preview);
			out.push(``);
		}
	}

	out.push(`_log:_ \`${summaryPath}\``);

	ctx.ui.notify(out.join("\n"), "info");
}

async function runWire(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { docs } = discoverDocs();
	if (docs.length === 0) {
		ctx.ui.notify("No managed docs.", "warning");
		return;
	}
	const lines = docs.map((d) => `@${d.docPath}`);
	ctx.ui.notify(
		`Add the following lines to your Pi system prompt config to include all compound-managed docs:\n\n${lines.join("\n")}`,
		"info",
	);
	try {
		const cmd = process.platform === "darwin" ? "pbcopy" : "xclip";
		execFileSync(cmd, process.platform === "darwin" ? [] : ["-selection", "clipboard"], {
			input: lines.join("\n"),
			stdio: ["pipe", "ignore", "ignore"],
		});
	} catch {
		// ignore
	}
}

// ─── Extension entry point ────────────────────────────────────────────────

export default function pi_compound(pi: ExtensionAPI) {
	pi.registerCommand("compound", {
		description:
			"Retroactively propose additions to your context docs from past Pi sessions. Flags: --since 7d, --limit N, --top N, --docs name1,name2, --sessions path1,path2, --dry-run, --no-gate, --gate-model provider/id",
		handler: runCompound,
	});

	pi.registerCommand("compound:init", {
		description: "Scaffold ~/.pi/agent/compound/ with a starter context doc + sidecar.",
		handler: runInit,
	});

	pi.registerCommand("compound:status", {
		description: "Show per-doc compound status (last run, approved, rejected, skipped).",
		handler: runStatus,
	});

	pi.registerCommand("compound:wire", {
		description: "Print (and copy) the system-prompt include lines for all compound-managed docs.",
		handler: runWire,
	});

	pi.registerCommand("compound:last", {
		description:
			"Render the most recent run's summary, including Stage 2 rejection reasons and surviving proposals. Optional arg: substring of a run filename to show that run instead.",
		handler: runLast,
	});
}
