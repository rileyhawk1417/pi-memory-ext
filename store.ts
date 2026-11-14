/**
 * Memory store logic for the pi memory extension.
 *
 * Layout:
 *   <root>/INDEX.md                  generated, lists subfolders + root files
 *   <root>/<category>/<slug>.md      one focused topic per file, with frontmatter
 *   <root>/<category>/INDEX.md       generated, lists the files in that folder
 *   <root>/.trash/                   forgotten files are moved here
 *
 * Scope:
 *   global  → ~/.pi/agent/memory   (override with PI_MEMORY_DIR)
 *   project → <cwd>/.pi/memory
 *
 * This module is dependency-free (pure Node) so it can be tested standalone.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type Scope = "global" | "project";

export interface MemoryMeta {
	title: string;
	tags: string[];
	scope: string;
	created: string;
	updated: string;
	/** Unknown frontmatter keys, preserved across tool updates. */
	extra: Record<string, string>;
}

export interface Entry {
	rel: string; // posix rel path, e.g. domains/typescript/tooling.md
	dir: string; // posix dir, "." for root
	file: string; // basename
	title: string;
	summary: string;
	tags: string[];
	extra: Record<string, string>;
	updated: string;
}

export const INDEX_NAME = "INDEX.md";
const TRASH_DIR = ".trash";
const MAX_DEPTH = 4;
const STALE_DAYS = 90;

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

export function getGlobalRoot(): string {
	return process.env.PI_MEMORY_DIR
		? path.resolve(process.env.PI_MEMORY_DIR)
		: path.join(os.homedir(), ".pi", "agent", "memory");
}

export function getProjectRoot(cwd: string): string {
	return path.join(path.resolve(cwd), ".pi", "memory");
}

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

/** Lowercase kebab-case segment: [a-z0-9-], no empty/`.`/`..`. */
export function sanitizeSegment(s: string): string | null {
	const cleaned = s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!cleaned || cleaned === "." || cleaned === "..") return null;
	return cleaned;
}

/** Category like "typescript" or "projects/basket" — max 2 segments. */
export function parseCategory(category: string | undefined): string {
	if (!category) return "general";
	const segments = category
		.split("/")
		.map(sanitizeSegment)
		.filter((s): s is string => s !== null)
		.slice(0, 2);
	return segments.length ? segments.join("/") : "general";
}

export function slugify(title: string): string {
	return sanitizeSegment(title.split("\n")[0].slice(0, 60)) ?? "note";
}

/** Resolve a rel path, refusing escapes outside root. Returns null if outside. */
export function resolveInside(root: string, rel: string): string | null {
	const rootAbs = path.resolve(root);
	const abs = path.resolve(rootAbs, rel);
	if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
	return abs;
}

/**
 * Tolerate the scope tag that the digest prints, so a model copying a line does
 * not have to know whether it is part of the path.
 *
 *   "[global] preferences/x.md"          → "preferences/x.md"
 *   "global/preferences/x.md"           → "preferences/x.md"
 *   "project (myrepo)/general/x.md"     → "general/x.md"
 *   "./preferences/X.md"                → "preferences/X.md"
 *
 * Unknown prefixes are left alone: a category may legitimately be called
 * "global" or "project", and stripping it would break reads that already work.
 */
export function normalizeRelPath(rel: string, labels: string[]): string {
	let p = rel.trim();
	const bracketed = p.match(/^\[([^\]]+)\]\s*(.+)$/);
	if (bracketed) p = `${bracketed[1]}/${bracketed[2]}`;
	p = p.replace(/^\.\//, "").replace(/^\/+/, "");
	const lower = p.toLowerCase();
	// Longest label first: "project (repo)" must win over "project".
	for (const label of [...labels].sort((a, b) => b.length - a.length)) {
		const prefix = `${label.toLowerCase()}/`;
		if (lower.startsWith(prefix)) return p.slice(prefix.length);
	}
	return p;
}

/**
 * Other paths worth trying when a model prefixes the scope loosely
 * ("project/preferences/x.md", "global (laptop)/notes.md"). Existence is
 * checked by the caller, so a category that really is called "project" still
 * resolves: the plain path is tried first.
 */
export function pathCandidates(rel: string): string[] {
	const out = [rel];
	const stripped = rel.match(/^(?:global|project)\s*(?:\([^)]*\))?\/(.+)$/);
	if (stripped) out.push(stripped[1]);
	return out;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export function serializeFrontmatter(meta: MemoryMeta, body: string): string {
	const lines = [
		"---",
		`title: ${meta.title}`,
		`tags: ${meta.tags.join(", ")}`,
		`scope: ${meta.scope}`,
		`created: ${meta.created}`,
		`updated: ${meta.updated}`,
	];
	for (const [key, value] of Object.entries(meta.extra)) lines.push(`${key}: ${value}`);
	lines.push("---", "");
	return lines.join("\n") + body;
}

export function parseFrontmatter(raw: string): { meta: MemoryMeta; body: string } {
	const meta: MemoryMeta = {
		title: "",
		tags: [],
		scope: "global",
		created: "",
		updated: "",
		extra: {},
	};
	let body = raw;

	if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
		const end = raw.indexOf("\n---", 4);
		if (end !== -1) {
			const block = raw.slice(4, end);
			body = raw.slice(raw.indexOf("\n", end + 1) + 1);
			for (const line of block.split(/\r?\n/)) {
				const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
				if (!m) continue;
				const key = m[1];
				const value = m[2].trim();
				if (key === "title") meta.title = value;
				else if (key === "tags") meta.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
				else if (key === "scope") meta.scope = value;
				else if (key === "created") meta.created = value;
				else if (key === "updated") meta.updated = value;
				else meta.extra[key] = value;
			}
		}
	}
	return { meta, body };
}

function firstMeaningfulLine(body: string): string {
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const cleaned = line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").replace(/[*_`]/g, "").trim();
		if (cleaned) return cleaned;
	}
	return "";
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

export function nowIso(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function isMemoryFile(rel: string): boolean {
	const posix = rel.split(path.sep).join("/");
	if (posix === INDEX_NAME || posix.startsWith(`${TRASH_DIR}/`) || posix.endsWith(`/${INDEX_NAME}`)) {
		return false;
	}
	return posix.endsWith(".md");
}

export function collectEntries(root: string): Entry[] {
	if (!fs.existsSync(root)) return [];
	const entries: Entry[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > MAX_DEPTH) return;
		let names: fs.Dirent[];
		try {
			names = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const name of names) {
			if (name.name === TRASH_DIR || name.name.startsWith(".")) continue;
			const abs = path.join(dir, name.name);
			if (name.isDirectory()) walk(abs, depth + 1);
			else if (name.isFile() && name.name.endsWith(".md") && name.name !== INDEX_NAME) {
				const rel = path.relative(root, abs).split(path.sep).join("/");
				const { meta, body } = parseFrontmatter(fs.readFileSync(abs, "utf8"));
				entries.push({
					rel,
					dir: path.posix.dirname(rel),
					file: name.name,
					title: meta.title || name.name.replace(/\.md$/, ""),
					summary: firstMeaningfulLine(body),
					tags: meta.tags,
					extra: meta.extra,
					updated: meta.updated,
				});
			}
		}
	};
	walk(root, 0);
	entries.sort((a, b) => a.rel.localeCompare(b.rel));
	return entries;
}

export function readFile(root: string, rel: string): string | null {
	const abs = resolveInside(root, rel);
	if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
	return fs.readFileSync(abs, "utf8");
}

export interface SaveOptions {
	title: string;
	content: string;
	tags?: string[];
	category?: string;
	scope: Scope;
	/** Project display name for `scope: project` metadata; derived from path if omitted. */
	projectName?: string;
	/** Additional frontmatter keys to record; merged over keys preserved from a prior file. */
	extra?: Record<string, string>;
}

export interface SaveResult {
	path: string; // posix rel path under root
	updatedExisting: boolean;
}

/** Repo name for `scope: project` metadata: <repo>/.pi/memory → "repo". */
function projectNameFor(rootAbs: string): string {
	const parent = path.basename(path.dirname(rootAbs));
	return parent === ".pi" ? path.basename(path.dirname(path.dirname(rootAbs))) : parent;
}

export async function saveMemory(root: string, opts: SaveOptions): Promise<SaveResult> {
	const rootAbs = path.resolve(root);
	const scopeName = opts.scope === "project" ? `project:${opts.projectName || projectNameFor(rootAbs)}` : "global";
	const category = parseCategory(opts.category);
	const dir = path.join(root, category);
	const rel = path.posix.join(category, `${slugify(opts.title)}.md`);
	const abs = resolveInside(root, rel);
	if (!abs) throw new Error(`Invalid memory path: ${rel}`);
	await fsp.mkdir(dir, { recursive: true });

	const updatedExisting = fs.existsSync(abs);
	const prior = updatedExisting ? parseFrontmatter(fs.readFileSync(abs, "utf8")).meta : null;
	// Tags are replaced only when explicitly provided; an update without tags keeps the old ones.
	const tags =
		opts.tags !== undefined
			? opts.tags.map((t) => sanitizeSegment(t)).filter((t): t is string => !!t)
			: (prior?.tags ?? []);
	const created = prior?.created || nowIso();
	const meta: MemoryMeta = {
		title: opts.title.split("\n")[0].trim() || slugify(opts.title),
		tags,
		scope: scopeName,
		created,
		updated: nowIso(),
		// Preserve unknown frontmatter keys across updates (e.g. hand-written 'pointer: ...').
		extra: { ...(prior?.extra ?? {}), ...(opts.extra ?? {}) },
	};
	await fsp.writeFile(abs, serializeFrontmatter(meta, opts.content.endsWith("\n") ? opts.content : opts.content + "\n"), "utf8");
	return { path: rel, updatedExisting };
}

/** Move a memory file to the root's .trash/ with recovery-friendly naming. */
export async function forgetMemory(root: string, rel: string): Promise<string | null> {
	const abs = resolveInside(root, rel);
	if (!abs || !fs.existsSync(abs)) return null;
	const trashDir = path.join(root, TRASH_DIR);
	await fsp.mkdir(trashDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const target = path.join(trashDir, `${stamp}-${path.basename(abs)}`);
	await fsp.rename(abs, target);
	return path.relative(root, target).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Generated indexes
// ---------------------------------------------------------------------------

function recursiveCount(entries: Entry[], dirPrefix: string): number {
	// dirPrefix is a top-level folder name without trailing slash; count the
	// folder itself (dir === prefix) plus everything nested under it.
	return entries.filter((e) => e.dir === dirPrefix || e.dir.startsWith(`${dirPrefix}/`)).length;
}

export function rootIndexText(entries: Entry[]): string {
	const lines = [
		"<!-- Generated by the pi memory extension. Do not edit by hand. -->",
		"# Memory Index",
		"",
		"One focused topic per file. Read a subfolder's INDEX.md before opening its files.",
		"",
	];
	const subdirs = [...new Set(entries.filter((e) => e.dir !== ".").map((e) => e.dir.split("/")[0]))].sort();
	if (subdirs.length) {
		lines.push("## Subfolders");
		lines.push("");
		for (const sub of subdirs) {
			const count = recursiveCount(entries, sub);
			lines.push(`- \`${sub}/\` — ${count} ${count === 1 ? "memory" : "memories"} → \`${sub}/${INDEX_NAME}\``);
		}
		lines.push("");
	}
	const rootFiles = entries.filter((e) => e.dir === ".");
	if (rootFiles.length) {
		lines.push("## Files");
		lines.push("");
		for (const e of rootFiles) lines.push(`- [\`${e.file}\`](./${e.file}) — ${e.title}`);
		lines.push("");
	}
	if (!subdirs.length && !rootFiles.length) {
		lines.push("No memories saved yet.");
		lines.push("");
	}
	return lines.join("\n");
}

export function subIndexText(entries: Entry[], dir: string): string {
	const dirEntries = entries.filter((e) => e.dir === dir);
	const lines = [
		"<!-- Generated by the pi memory extension. Do not edit by hand. -->",
		`# Index: ${dir}`,
		"",
	];
	for (const e of dirEntries) {
		const link = path.posix.basename(e.rel);
		lines.push(`- [\`${link}\`](./${link}) — ${e.title}`);
	}
	lines.push("");
	return lines.join("\n");
}

export function writeIndexes(root: string, entries: Entry[]): number {
	fs.mkdirSync(root, { recursive: true });
	let written = 0;
	fs.writeFileSync(path.join(root, INDEX_NAME), rootIndexText(entries), "utf8");
	written++;
	const dirs = [...new Set(entries.map((e) => e.dir).filter((d) => d !== "."))];
	for (const dir of dirs) {
		const dirAbs = resolveInside(root, dir);
		if (!dirAbs) continue;
		fs.mkdirSync(dirAbs, { recursive: true });
		fs.writeFileSync(path.join(dirAbs, INDEX_NAME), subIndexText(entries, dir), "utf8");
		written++;
	}
	return written;
}

/** Remove INDEX.md (then rmdir) in subdirs that no longer hold any memory files. */
function pruneOrphanIndexes(root: string, entries: Entry[]): number {
	if (!fs.existsSync(root)) return 0;
	let pruned = 0;
	const filled = new Set([...entries.map((e) => e.dir), ...entries.map((e) => path.posix.dirname(e.dir))]);
	const walk = (dir: string, depth: number) => {
		if (depth > MAX_DEPTH) return;
		for (const name of fs.readdirSync(dir)) {
			if (name.startsWith(".")) continue;
			const abs = path.join(dir, name);
			if (!fs.statSync(abs).isDirectory()) continue;
			walk(abs, depth + 1);
			const rel = path.relative(root, abs).split(path.sep).join("/");
			if (filled.has(rel)) continue;
			const indexAbs = path.join(abs, INDEX_NAME);
			if (fs.existsSync(indexAbs) && fs.readdirSync(abs).length === 1) {
				fs.rmSync(indexAbs);
				pruned++;
			}
			try {
				if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
			} catch {
				/* non-empty now; leave it */
			}
		}
	};
	walk(root, 0);
	return pruned;
}

/** Recompute and write every index under root. Returns counts. */
export function regenerate(root: string): { files: number; indexes: number; pruned: number } {
	const entries = collectEntries(root);
	const indexes = writeIndexes(root, entries);
	const pruned = pruneOrphanIndexes(root, entries);
	return { files: entries.length, indexes, pruned };
}

/** Compute the root index view without writing (for the `list` action). */
export function listMemoryText(root: string): string {
	return rootIndexText(collectEntries(root));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit {
	root: string;
	rel: string;
	title: string;
	snippet: string;
}

interface SearchHitWithScore extends SearchHit {
	score: number;
}

function tokenize(query: string): string[] {
	return query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Small suffix stemmer so "processes"/"building" match "process"/"build".
 *
 * Deliberately conservative: a stem is only a prefix of the original word, so
 * it must stay a substring of the words it is meant to match. Blanket-stripping
 * "es" used to turn "files" into "fil", which then matched "profile" and
 * "filter"; sibilant plurals are the only place "es" is correct.
 */
export function stem(token: string): string {
	if (token.length <= 3) return token;
	if (token.endsWith("sses")) return token.slice(0, -2); // processes → process
	if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`; // policies → policy
	if (/(?:ss|us|is)$/.test(token)) return token; // status, analysis, class
	if (token.endsWith("s")) return token.slice(0, -1); // files → file, causes → cause
	for (const suffix of ["ing", "ed"]) {
		if (!token.endsWith(suffix) || token.length <= suffix.length + 2) continue;
		const cut = token.slice(0, -suffix.length);
		// running → runn → run, stopped → stopp → stop
		return /([b-df-hj-np-tv-z])\1$/.test(cut) ? cut.slice(0, -1) : cut;
	}
	return token;
}

/**
 * Match a term where a word starts, so "file" hits "file"/"files"/"files.md" but
 * not "profile", and "note" hits "notes" but not "nothing". Plain substring
 * matching over-stems its way into unrelated words.
 */
function containsTerm(haystack: string, term: string): boolean {
	for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + 1)) {
		if (at === 0 || !/[a-z0-9]/.test(haystack[at - 1])) return true;
	}
	return false;
}

/** Body after the frontmatter block, so snippets never quote metadata. */
function bodyOnly(text: string): string {
	if (!text.startsWith("---")) return text;
	const close = text.indexOf("\n---", 3);
	if (close === -1) return text;
	const nl = text.indexOf("\n", close + 4);
	return nl === -1 ? "" : text.slice(nl + 1);
}

export function searchMemory(roots: { label: string; root: string }[], query: string, limit = 10): SearchHit[] {
	const tokens = [...new Set(tokenize(query))];
	const stems = tokens.map(stem);
	if (!tokens.length) return [];
	const hits: SearchHitWithScore[] = [];

	for (const { label, root } of roots) {
		for (const entry of collectEntries(root)) {
			const pathHaystack = `${entry.rel} ${entry.title} ${entry.tags.join(" ")} ${Object.entries(entry.extra).map(([k, v]) => `${k} ${v}`).join(" ")}`.toLowerCase();
			const contentAbs = resolveInside(root, entry.rel);
			const content = contentAbs ? fs.readFileSync(contentAbs, "utf8").toLowerCase() : "";

			// Softened matching: only ONE matching token required; coverage drives ranking.
			let pathHits = 0;
			let contentHits = 0;
			let firstToken: string | null = null;
			for (let i = 0; i < tokens.length; i++) {
				for (const t of [tokens[i], stems[i]]) {
					if (containsTerm(pathHaystack, t)) {
						pathHits++;
						firstToken ??= t;
						break;
					}
					if (containsTerm(content, t)) {
						contentHits++;
						firstToken ??= t;
						break;
					}
				}
			}
			if (!firstToken) continue;

			const score = (pathHits * 3 + contentHits) * ((pathHits + contentHits) / tokens.length);

			const line = bodyOnly(content)
				.split("\n")
				.find((l) => containsTerm(l, firstToken));
			const snippet = (line?.trim() ?? entry.summary).slice(0, 120);
			hits.push({ root: label, rel: entry.rel, title: entry.title, snippet, score });
		}
	}

	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit).map(({ root, rel, title, snippet }) => ({ root, rel, title, snippet }));
}

// ---------------------------------------------------------------------------
// Digest — injected at session start so future sessions know what's there
// ---------------------------------------------------------------------------

/** Keep injected text flat and short: it lands in the system prompt. */
function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One line per memory: `path — title (tags) [scope]`.
 *
 * The path leads so a model can copy it straight into `memory read`. Entries
 * are interleaved between roots and capped in total, because appending roots in
 * order let a large project root crowd the global root out of the digest — and
 * the global root is where cross-project preferences live.
 */
export function buildDigest(
	roots: { label: string; root: string }[],
	cap = 40,
): { lines: string[]; total: number; omitted: { label: string; count: number }[] } {
	const perRoot = roots.map(({ label, root }) => ({
		label,
		entries: collectEntries(root)
			.slice()
			.sort((a, b) => (b.updated || "").localeCompare(a.updated || "") || a.rel.localeCompare(b.rel)),
	}));
	const total = perRoot.reduce((n, r) => n + r.entries.length, 0);

	const line = (label: string, entry: Entry): string => {
		const tags = entry.tags
			.slice(0, 5)
			.map((t) => clip(t, 24))
			.filter(Boolean)
			.join(", ");
		return `- ${clip(entry.rel, 80)} — ${clip(entry.title, 90)}${tags ? ` (tags: ${tags})` : ""} [${label}]`;
	};

	const lines: string[] = [];
	const shown = new Map(perRoot.map((r) => [r.label, 0]));
	for (let i = 0; lines.length < cap; i++) {
		if (!perRoot.some((r) => i < r.entries.length)) break;
		for (const r of perRoot) {
			if (lines.length >= cap || i >= r.entries.length) continue;
			lines.push(line(r.label, r.entries[i]));
			shown.set(r.label, (shown.get(r.label) ?? 0) + 1);
		}
	}

	const omitted = perRoot
		.map((r) => ({ label: r.label, count: r.entries.length - (shown.get(r.label) ?? 0) }))
		.filter((o) => o.count > 0);
	if (omitted.length) {
		const detail = omitted.map((o) => `${o.label}: ${o.count}`).join(", ");
		const more = omitted.reduce((n, o) => n + o.count, 0);
		lines.push(`…and ${more} more (${detail}) — use \`memory list\` or \`memory search\` to find them.`);
	}
	return { lines, total, omitted };
}

/** Find existing memories whose normalized title is near-duplicate of `title`. */
export function findSimilarTitle(root: string, title: string, excludeRel?: string): Entry[] {
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2).map(stem));
	const a = words(title);
	if (!a.size) return [];
	const out: Entry[] = [];
	for (const entry of collectEntries(root)) {
		if (entry.rel === excludeRel) continue;
		const b = words(entry.title);
		let inter = 0;
		for (const w of b) if (a.has(w)) inter++;
		const union = new Set([...a, ...b]).size;
		const jaccard = union ? inter / union : 0;
		if (jaccard >= 0.6 || norm(title).includes(norm(entry.title)) || norm(entry.title).includes(norm(title))) {
			out.push(entry);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Taxonomy hints + report
// ---------------------------------------------------------------------------

export function existingCategories(root: string): { name: string; count: number }[] {
	const entries = collectEntries(root);
	const byCategory = new Map<string, number>();
	for (const e of entries) {
		const top = e.dir === "." ? "general" : e.dir.split("/")[0];
		byCategory.set(top, (byCategory.get(top) ?? 0) + 1);
	}
	return [...byCategory.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

function levenshtein(a: string, b: string): number {
	const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 0; j <= b.length; j++) dp[0][j] = j;
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++)
			dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
	return dp[a.length][b.length];
}

/** Suggest existing categories close to a new one (same first token or small edit distance). */
export function nearestCategory(category: string, existing: { name: string; count: number }[]): string | null {
	const cat = sanitizeSegment(category) ?? "";
	if (existing.some((e) => e.name === cat)) return null;
	for (const e of existing) {
		const first = cat.split("-")[0];
		if (first && (e.name === first || e.name.startsWith(`${first}-`))) return e.name;
	}
	for (const e of existing) {
		if (levenshtein(cat, e.name) <= 2) return e.name;
	}
	return null;
}

export interface ReportOptions {
	staleDays?: number;
}

export function buildReport(roots: { label: string; root: string }[], opts: ReportOptions = {}): string[] {
	const staleDays = opts.staleDays ?? STALE_DAYS;
	const lines: string[] = [];

	for (const { label, root } of roots) {
		const entries = collectEntries(root);
		lines.push(`${label}: ${entries.length} ${entries.length === 1 ? "memory" : "memories"}`);
		if (!fs.existsSync(root)) {
			lines.push("  (directory does not exist yet)");
			continue;
		}

		const seen = new Map<string, Entry>();
		for (const e of entries) {
			const key = e.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
			const prior = seen.get(key);
			if (prior) lines.push(`  duplicate title: "${e.title}" — ${prior.rel} and ${e.rel}`);
			else seen.set(key, e);
		}

		if (entries.length) {
			const cutoff = new Date();
			cutoff.setDate(cutoff.getDate() - staleDays);
			for (const e of entries) {
				const updated = e.updated ? new Date(e.updated.replace(" ", "T")) : new Date(0);
				if (Number.isNaN(updated.getTime()) || updated < cutoff) {
					lines.push(`  possibly stale (> ${staleDays}d, updated ${e.updated || "never"}): ${e.rel}`);
				}
			}
		}

		const categories = existingCategories(root);
		if (categories.length) {
			lines.push(`  categories: ${categories.map((c) => `${c.name}(${c.count})`).join(", ")}`);
		}
	}
	return lines;
}