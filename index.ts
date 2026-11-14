/**
 * pi memory extension — hierarchical markdown memory with generated indexes.
 *
 * Memory roots:
 *   global  → ~/.pi/agent/memory          (cross-project; override with PI_MEMORY_DIR)
 *   project → <cwd>/.pi/memory            (this repository only)
 *
 * Model-facing tool `memory` (save/read/search/list/forget) + user command
 * /memory (status | rebuild | review). INDEX.md files are generated on every
 * save/forget and on `/memory rebuild` — never edit them by hand.
 */
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as store from "./store.ts";

const GUIDANCE = `Memory tool: "global" scope → ~/.pi/agent/memory (cross-project user preferences), "project" scope → <cwd>/.pi/memory (this repository only). The digest above lists what exists.
- Recall: when the user asks you to remember, recall, check past context, or what was done before, use \`memory search\` / \`memory list\` + INDEX.md; never guess memory paths.
- Capture: when the user asks to save, store, or checkpoint something, use \`memory save\`. User preferences and cross-project knowledge → "global"; anything about this repository (conventions, decisions, research summaries, session checkpoints, artifact locations) → "project".
- One focused topic per file with an imperative title stating the rule or fact. If a similar memory likely exists, search first and update it instead of creating a near-duplicate.
- Never repurpose AGENTS.md, .pi/SYSTEM.md, APPEND_SYSTEM.md, or docs files as memory/checkpoint storage — they load into every prompt.
- INDEX.md files are generated; never edit them or write into memory folders with other file tools — use the memory tool.`;

interface Roots {
	label: string;
	root: string;
}

function rootsFor(scope: "global" | "project" | "all" | undefined, ctx: ExtensionContext): Roots[] {
	const global = { label: "global", root: store.getGlobalRoot() };
	const project = { label: `project (${path.basename(ctx.cwd)})`, root: store.getProjectRoot(ctx.cwd) };
	if (scope === "global") return [global];
	if (scope === "project") return [project];
	return [project, global];
}

interface Resolved {
	label: string;
	root: string;
	rel: string;
	content: string;
}

/**
 * Resolve a user-copied path across loose prefixes, path candidates and roots.
 * The first existing file wins; the plain path is always tried first, so a
 * category legitimately named "project" or "global" still resolves.
 */
function resolveAcrossRoots(roots: Roots[], input: string): Resolved | null {
	const labels = roots.map((r) => r.label);
	for (const rel of store.pathCandidates(store.normalizeRelPath(input, labels))) {
		for (const { label, root } of roots) {
			const content = store.readFile(root, rel);
			if (content !== null) return { label, root, rel, content };
		}
	}
	return null;
}


const MemoryParams = Type.Object({
	action: StringEnum(["save", "read", "search", "list", "forget"] as const, {
		description:
			"save: store a memory (title + content required). read: read a specific file (path). search: find memories by keywords (query). list: show the memory index. forget: move a memory to trash (path).",
	}),
	scope: Type.Optional(
		StringEnum(["global", "project", "all"] as const, {
			description:
				"global = ~/.pi/agent/memory (cross-project preferences, shared knowledge). project = <cwd>/.pi/memory (this repository only). all = both roots, for read/search/list/forget. Default: global for save, all for others.",
		}),
	),
	title: Type.Optional(
		Type.String({
			description:
				"Imperative title stating the rule or fact, e.g. 'Kill Java processes after builds' — not a topic label like 'Gradle notes'. Required for save.",
		}),
	),
	content: Type.Optional(
		Type.String({ description: "Markdown body of the memory. Required for save." }),
	),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Optional kebab-case tags, e.g. ['typescript', 'testing']." })),
	category: Type.Optional(
		Type.String({
			description:
				"Subfolder for save, kebab-case, max 2 levels: 'typescript', 'preferences', 'projects/basket'. Default: 'general'.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"Relative path for read/forget, e.g. 'INDEX.md', 'domains/typescript/tooling.md'. Always take paths from the index, never guess.",
		}),
	),
	query: Type.Optional(Type.String({ description: "Keywords for search, e.g. 'basket deployment'. Required for search." })),
});

export default function memoryExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Read and write persistent markdown memory in two scopes: global (~/.pi/agent/memory, cross-project user preferences and shared knowledge) and project (<cwd>/.pi/memory, specific to the current repository — conventions, decisions, research summaries, session checkpoints; directory is created automatically on first save). " +
			"Hierarchical and index-first: each root has a generated INDEX.md listing subfolders, each subfolder has its own INDEX.md listing files. Read the relevant index first, then the specific files it points to; take paths from the index, never guess them. " +
			"Use save for durable facts the user asks to remember ('save this in memory', 'checkpoint this'), preferring project scope for anything repository-specific. If a similar memory may exist, search first and update it instead of creating a near-duplicate.",
		parameters: MemoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roots = rootsFor(params.scope, ctx);

			try {
				switch (params.action) {
					case "save": {
						const { title, content } = params;
						if (!title || !content) {
							return fail("save requires 'title' and 'content'");
						}
						const scope = params.scope === "project" ? "project" : "global";
						const target = rootsFor(scope, ctx)[0];
						const result = await withFileMutationQueue(target.root, async () => {
							const saved = await store.saveMemory(target.root, {
								title,
								content,
								tags: params.tags,
								category: params.category,
								scope,
								projectName: path.basename(ctx.cwd),
							});
							store.regenerate(target.root);
							return saved;
						});

						const hint = taxonomyHint(target.root, params.category);
						const similar = store.findSimilarTitle(target.root, title, result.path).slice(0, 3);
						const dupHint = similar.length
							? `\nNear-duplicate title${similar.length > 1 ? "s" : ""}: ${similar.map((e) => `'${e.title}' (${e.rel})`).join("; ")} — prefer updating one canonical file and \`memory forget\`ting the others.`
							: "";
						const verb = result.updatedExisting ? "Updated existing memory" : "Saved new memory";
						const text = [
							`${verb} '${title}' at ${result.path} (${target.label}).`,
							`Index regenerated. ${hint}${dupHint}`,
						]
							.filter(Boolean)
							.join("\n");
						return ok(text, { action: "save", path: result.path, root: target.label, updated: result.updatedExisting, similar: similar.map((e) => e.rel) });
					}

					case "read": {
						if (!params.path) return fail("read requires 'path' (take it from the index)");
						const found = resolveAcrossRoots(roots, params.path);
						if (!found) {
							return fail(`${params.path} not found in memory. Try \`memory list\` or \`memory search\`.`);
						}
						return ok(bound(found.content), { action: "read", path: found.rel, root: found.label });
					}

					case "search": {
						if (!params.query) return fail("search requires 'query'");
						const hits = store.searchMemory(roots, params.query);
						if (!hits.length) {
							return ok(
								`No memories matched '${params.query}'. Try \`memory list\` to browse the index.`,
								{ action: "search", hits: 0 },
							);
						}
						const text = hits.map((h) => `- [${h.root}] ${h.rel} — ${h.title}\n  ${h.snippet}`).join("\n");
						return ok(`${hits.length} match(es) for '${params.query}':\n${text}`, { action: "search", hits: hits.length });
					}

					case "list": {
						const texts: string[] = [];
						for (const { label, root } of roots) {
							texts.push(`== ${label} ==\n${store.listMemoryText(root)}`);
						}
						const text = texts.join("\n") + "\nDrill down with \`memory read\` on a subfolder's INDEX.md.";
						return ok(text, { action: "list" });
					}

					case "forget": {
						if (!params.path) return fail("forget requires 'path'");
						const found = resolveAcrossRoots(roots, params.path);
						if (!found) {
							return fail(`${params.path} not found in memory. Try \`memory list\` or \`memory search\`.`);
						}
						if (found.rel === store.INDEX_NAME || found.rel.endsWith(`/${store.INDEX_NAME}`)) {
							return fail("INDEX.md files are generated and cannot be forgotten directly.");
						}
						const trashRel = await withFileMutationQueue(path.join(found.root, found.rel), async () => {
							const moved = await store.forgetMemory(found.root, found.rel);
							if (moved) store.regenerate(found.root);
							return moved;
						});
						if (!trashRel) return fail(`${params.path} could not be forgotten.`);
						return ok(
							`Moved ${found.rel} (${found.label}) to ${trashRel}. Index regenerated. Recover it from .trash/ if needed.`,
							{ action: "forget", path: found.rel, root: found.label },
						);
					}

					default:
						return fail(`Unknown action: ${params.action as string}`);
				}
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}
		},

		renderCall(args, theme: Theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("memory ")) + theme.fg("muted", args.action);
			if (args.scope) text += ` ${theme.fg("accent", `[${args.scope}]`)}`;
			if (args.title) text += ` ${theme.fg("dim", `"${truncateToWidth(args.title, 40)}"`)}`;
			if (args.path) text += ` ${theme.fg("muted", args.path)}`;
			if (args.query) text += ` ${theme.fg("muted", `"${truncateToWidth(args.query, 40)}"`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("memory", {
		description: "Memory: status, rebuild indexes, or review report",
		handler: async (args, ctx) => {
			const [subcommand] = args.trim().split(/\s+/).filter(Boolean);
			const roots = rootsFor("all", ctx);

			if (!subcommand || subcommand === "status") {
				const report = store.buildReport(roots);
				notify(ctx, report.length ? report.join("\n") : "Memory is empty. Nothing saved yet.");
				return;
			}
			if (subcommand === "rebuild") {
				const lines: string[] = [];
				for (const { label, root } of roots) {
					const { files, indexes, pruned } = store.regenerate(root);
					lines.push(
						`${label}: ${files} memories, ${indexes} index file(s) regenerated${pruned ? `, ${pruned} orphan index pruned` : ""}`,
					);
				}
				notify(ctx, lines.join("\n"));
				return;
			}
			if (subcommand === "review") {
				const report = store.buildReport(roots);
				notify(ctx, report.join("\n"));
				const actionable = report.some(
					(line) => line.includes("duplicate title:") || line.includes("possibly stale"),
				);
				if (!actionable) {
					notify(ctx, "Nothing to resolve: no duplicates or stale entries found.");
					return;
				}
				const prompt = [
					"The /memory review command flagged the following memory issues:",
					"",
					...report.map((line) => (line ? line : "")),
					"",
					"Please resolve them now with the memory tool:",
					"- Duplicates: \`memory search\` + \`memory read\` both files, merge into the better one, and \`memory forget\` the other.",
					"- Stale memories: read each; update it with \`memory save\` if the info is still relevant, \`memory forget\` it if it is clearly obsolete, otherwise leave it and mention it.",
					"Indexes regenerate automatically on every save/forget, so no manual index edits.",
					"Finish with a one-line summary of what you merged, updated, or forgot.",
				].join("\n");
				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					notify(ctx, "Agent is busy — the review will be delivered once the current run finishes.");
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
				return;
			}
			notify(ctx, `Unknown subcommand '${subcommand}'. Use /memory, /memory rebuild, or /memory review.`);
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		const roots = rootsFor("all", ctx);
		const { lines, total } = store.buildDigest(roots);
		if (total > 0) {
			// Titles digest makes stored knowledge visible without injecting bodies.
			event.systemPromptOptions.sections.memory = [
				"If any line below could matter to the current task, `memory read <path>` that file before proceeding.",
				"Paths are relative to their root; the bracketed tag at the end of a line says which root it lives in.",
				...lines,
				"",
				GUIDANCE,
			].join("\n");
		} else {
			delete event.systemPromptOptions.sections.memory;
		}
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${text}` }],
		details: { error: text },
		isError: true,
	};
}

function bound(content: string): string {
	const lines = content.split("\n");
	if (lines.length > 400) {
		return lines.slice(0, 400).join("\n") + `\n... (${lines.length - 400} more lines) — use built-in read for the rest of the file.`;
	}
	return content;
}

function taxonomyHint(root: string, category?: string): string {
	if (!category) return "";
	const existing = store.existingCategories(root);
	const nearest = store.nearestCategory(category, existing);
	if (nearest) {
		return `Note: new category '${store.parseCategory(category)}' is similar to existing '${nearest}' — consider updating those memories instead, or run /memory review later to consolidate.`;
	}
	return "";
}

function notify(ctx: ExtensionContext, text: string) {
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else console.log(text);
}