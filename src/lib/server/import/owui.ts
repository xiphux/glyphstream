/**
 * Open WebUI export importer.
 *
 * Consumes the JSON shape produced by OWUI's "Export All Chats" / per-chat
 * export and writes conversations + messages into our schema. The export's
 * `chat.history` is already tree-shaped (parent pointers + currentId leaf
 * pointer), which maps directly onto our `parent_message_id` +
 * `active_leaf_message_id` columns — no flattening required.
 *
 * Imported conversations get a synthetic `endpoint_id = 'imported-owui'`
 * because OWUI's model identifiers don't translate to GlyphStream's
 * configured endpoints. The result: imported chats are read-only (sending
 * a new message will fail with "endpoint not configured"), but full
 * history is preserved and the conversations are searchable, archivable,
 * and deletable like any other.
 *
 * Image chats: OWUI's export references images via URLs to its internal
 * file API (`/api/v1/files/{id}/content`) rather than embedding the bytes.
 * Once OWUI is shut down those URLs 404. We rewrite the markdown to a
 * "[image unavailable]" placeholder so the surrounding conversation still
 * reads coherently.
 */

import { eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { conversations, messages } from '../db/schema';
import { generateId } from '../util/id';
import type * as schema from '../db/schema';
import { renderMarkdown } from '../markdown/render';
import type { MessagePart, ModelKind } from '$lib/types/api';

export type ImportDb = NodeSQLiteDatabase<typeof schema>;

export const IMPORTED_ENDPOINT_ID = 'imported-owui';

/** Strips OWUI's internal file-API URLs from markdown image references. */
const OWUI_FILE_URL_RE = /!\[([^\]]*)\]\(\/api\/v1\/files\/[^)]+\)/g;

/**
 * OWUI wraps assistant reasoning/thinking output in a collapsible
 * `<details type="reasoning">` block at the start of the message. The
 * inner content is HTML-entity-encoded and prefixed with markdown
 * blockquote markers (`> ...` rendered as `&gt; ...`).
 */
const OWUI_REASONING_RE = /<details\s+type="reasoning"[^>]*>([\s\S]*?)<\/details>/i;
const OWUI_SUMMARY_RE = /<summary[^>]*>[\s\S]*?<\/summary>/i;

export interface ImportOptions {
	/** Don't write to the DB; just count what would be imported. */
	dryRun?: boolean;
}

export interface ImportResult {
	imported: number;
	archived: number;
	skipped: { id: string; reason: string }[];
	errors: { id: string; reason: string }[];
}

interface OwuiExportEntry {
	id?: string;
	title?: string;
	chat?: OwuiChat;
	updated_at?: number;
	created_at?: number;
	archived?: boolean;
}

interface OwuiChat {
	title?: string;
	models?: string[];
	history?: OwuiHistory;
}

interface OwuiHistory {
	currentId?: string;
	messages?: Record<string, OwuiTreeMessage>;
}

interface OwuiTreeMessage {
	id?: string;
	parentId?: string | null;
	role?: string;
	content?: string;
	timestamp?: number;
	model?: string;
}

/**
 * Top-level entry point — accepts the raw JSON value (already parsed) so
 * the caller controls how it was loaded (file read, HTTP upload, fixture)
 * and the DB connection so the function works equally well from the
 * SvelteKit runtime, the CLI script, and unit tests without pulling in
 * `$env/dynamic/private` from the runtime env module.
 */
export async function importOwuiExport(
	rawJson: unknown,
	userId: string,
	db: ImportDb,
	opts: ImportOptions = {},
): Promise<ImportResult> {
	if (!Array.isArray(rawJson)) {
		throw new Error('Export root must be an array of conversations');
	}

	const result: ImportResult = {
		imported: 0,
		archived: 0,
		skipped: [],
		errors: [],
	};

	for (const entry of rawJson as OwuiExportEntry[]) {
		const id = entry?.id ?? '<unknown>';
		try {
			const outcome = await importOne(entry, userId, db, opts);
			if (outcome === 'skipped-no-history') {
				result.skipped.push({ id, reason: 'no chat.history.messages tree' });
				continue;
			}
			if (outcome === 'skipped-empty') {
				result.skipped.push({ id, reason: 'history has no usable messages' });
				continue;
			}
			result.imported++;
			if (outcome === 'imported-archived') {
				result.archived++;
			}
		} catch (e) {
			result.errors.push({
				id,
				reason: e instanceof Error ? e.message : String(e),
			});
		}
	}

	return result;
}

type ImportOutcome =
	| 'imported-active'
	| 'imported-archived'
	| 'skipped-no-history'
	| 'skipped-empty';

async function importOne(
	entry: OwuiExportEntry,
	userId: string,
	db: ImportDb,
	opts: ImportOptions,
): Promise<ImportOutcome> {
	const history = entry?.chat?.history;
	const owuiMessages = history?.messages;
	if (!owuiMessages || typeof owuiMessages !== 'object') {
		return 'skipped-no-history';
	}

	// Build the tree-walk plan: pick up roots (parentId == null), BFS down.
	// We need to insert parents before children to satisfy the self-FK on
	// messages.parent_message_id (well, the column doesn't have an FK
	// constraint actually, but topological order keeps the data sane).
	const idMap = new Map<string, string>(); // owui id -> new uuid
	const ordered: { owuiId: string; msg: OwuiTreeMessage }[] = [];
	const seen = new Set<string>();

	const roots = Object.values(owuiMessages).filter(
		(m): m is OwuiTreeMessage => !!m && (m.parentId === null || m.parentId === undefined),
	);
	const queue: OwuiTreeMessage[] = [...roots];
	while (queue.length > 0) {
		const m = queue.shift()!;
		const mid = m.id;
		if (!mid || seen.has(mid)) continue;
		seen.add(mid);
		ordered.push({ owuiId: mid, msg: m });
		// Find children by scanning messages whose parentId === mid.
		for (const candidate of Object.values(owuiMessages)) {
			if (candidate?.parentId === mid && candidate.id && !seen.has(candidate.id)) {
				queue.push(candidate);
			}
		}
	}

	// Some exports may have orphaned messages whose parent isn't in the tree
	// (e.g. references to a deleted parent). Append any remaining as roots
	// so we don't silently drop them.
	for (const m of Object.values(owuiMessages)) {
		if (m?.id && !seen.has(m.id)) {
			seen.add(m.id);
			ordered.push({ owuiId: m.id, msg: { ...m, parentId: null } });
		}
	}

	if (ordered.length === 0) return 'skipped-empty';

	// Pre-allocate new UUIDs so child rows can reference parents by mapped id.
	for (const { owuiId } of ordered) {
		idMap.set(owuiId, generateId());
	}

	const conversationId = generateId();
	const owuiModel = entry?.chat?.models?.[0] ?? 'unknown';
	const modelKind = detectModelKind(
		owuiModel,
		ordered.map((o) => o.msg),
	);
	const createdAt = secondsToMs(entry?.created_at) ?? Date.now();
	const updatedAt = secondsToMs(entry?.updated_at) ?? createdAt;
	const archivedAt = entry?.archived ? updatedAt : null;
	const activeLeafOwuiId = history?.currentId;
	const activeLeafNewId = activeLeafOwuiId
		? (idMap.get(activeLeafOwuiId) ?? null)
		: (idMap.get(ordered[ordered.length - 1].owuiId) ?? null);

	const title = entry?.title ?? entry?.chat?.title ?? null;

	if (opts.dryRun) {
		return archivedAt ? 'imported-archived' : 'imported-active';
	}

	// Pre-process assistant messages: split off OWUI's reasoning <details>
	// block, then markdown-render what's left. Both happen before the
	// transaction opens because renderMarkdown is async (shiki lazy-loads)
	// and node:sqlite transactions don't allow awaiting inside the
	// callback. The first render warms shiki; subsequent ones share the
	// cached singleton highlighter and are fast.
	interface PreparedAssistant {
		reasoning: string | null;
		content: string;
		contentHtml: string | null;
	}
	const preparedByOwuiId = new Map<string, PreparedAssistant>();
	for (const { owuiId, msg } of ordered) {
		if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
		const stripped = stripOwuiFileUrls(msg.content);
		const { reasoning, content } = extractReasoning(stripped);
		let contentHtml: string | null = null;
		try {
			contentHtml = await renderMarkdown(content);
		} catch {
			// Per-message render failures shouldn't abort the whole
			// conversation; fall back to plain text by leaving null.
		}
		preparedByOwuiId.set(owuiId, { reasoning, content, contentHtml });
	}

	db.transaction((tx) => {
		tx.insert(conversations)
			.values({
				id: conversationId,
				userId,
				title,
				endpointId: IMPORTED_ENDPOINT_ID,
				modelId: owuiModel,
				modelKind,
				customModelId: null,
				systemPrompt: null,
				parametersJson: null,
				activeLeafMessageId: null, // set after messages exist
				createdAt,
				updatedAt,
				archivedAt,
			})
			.run();

		for (const { owuiId, msg } of ordered) {
			const newId = idMap.get(owuiId)!;
			const role = normalizeRole(msg.role);

			let parts: MessagePart[];
			let contentHtml: string | null = null;
			let reasoningText: string | null = null;
			const prep = preparedByOwuiId.get(owuiId);
			if (role === 'assistant' && prep) {
				parts = [];
				if (prep.reasoning) parts.push({ type: 'reasoning', text: prep.reasoning });
				parts.push({ type: 'text', text: prep.content });
				contentHtml = prep.contentHtml;
				reasoningText = prep.reasoning;
			} else {
				const text = stripOwuiFileUrls(msg.content ?? '');
				parts = [{ type: 'text', text }];
			}

			tx.insert(messages)
				.values({
					id: newId,
					conversationId,
					parentMessageId:
						msg.parentId && idMap.get(msg.parentId) ? idMap.get(msg.parentId)! : null,
					role,
					contentJson: JSON.stringify(parts),
					contentHtml,
					reasoningText,
					finishReason: null,
					modelUsed: msg.model ?? null,
					tokensIn: null,
					tokensOut: null,
					rawResponseJson: null,
					createdAt: secondsToMs(msg.timestamp) ?? createdAt,
				})
				.run();
		}

		if (activeLeafNewId) {
			tx.update(conversations)
				.set({ activeLeafMessageId: activeLeafNewId })
				.where(eq(conversations.id, conversationId))
				.run();
		}
	});

	return archivedAt ? 'imported-archived' : 'imported-active';
}

/**
 * Inspect the message content first — it's a more reliable signal than
 * the model name (which can be ambiguous, e.g. `openai_image_video.foo`
 * could be either modality depending on the underlying workflow). Falls
 * back to substring detection on the model name only if content is
 * inconclusive.
 */
function detectModelKind(modelName: string, msgs: OwuiTreeMessage[]): ModelKind {
	for (const m of msgs) {
		if (m?.role !== 'assistant' || typeof m.content !== 'string') continue;
		// OWUI image generations produce ![alt](url) markdown.
		if (/!\[[^\]]*\]\(\/api\/v1\/files\/[^)]+\)/.test(m.content)) return 'image';
		if (/<video[\s>]|\.mp4(?:[?#]|$)/i.test(m.content)) return 'video';
	}
	const n = modelName.toLowerCase();
	if (n.includes('embed')) return 'embedding';
	return 'chat';
}

function normalizeRole(role: string | undefined): 'system' | 'user' | 'assistant' | 'tool' {
	if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
		return role;
	}
	// Unknown roles are most often quirks of older OWUI exports. Default to
	// 'user' so the message doesn't get dropped — better to surface a
	// slightly-wrong attribution than to silently lose content.
	return 'user';
}

function secondsToMs(seconds: number | null | undefined): number | null {
	if (seconds === null || seconds === undefined) return null;
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
	// OWUI uses seconds, our schema uses ms.
	return Math.floor(seconds * 1000);
}

export function stripOwuiFileUrls(markdown: string): string {
	// Collapse references to OWUI's `/api/v1/files/{id}/content` URLs into
	// a clear placeholder. Preserves the alt text so the user knows what
	// was supposed to be there.
	return markdown.replace(OWUI_FILE_URL_RE, (_match, alt) => {
		const label = alt && String(alt).trim().length > 0 ? `: ${alt}` : '';
		return `_[image unavailable${label}]_`;
	});
}

/**
 * Splits an OWUI assistant message into its reasoning preamble and the
 * remaining "real" answer. Both pieces are returned in their natural
 * markdown form — the reasoning has been entity-decoded and had its
 * blockquote prefix stripped, the answer has had the `<details>` block
 * removed entirely.
 *
 * Returns `{ reasoning: null, content: rawContent }` when no reasoning
 * block is present, so the caller can use a single code path for chats
 * with and without thinking output.
 */
export function extractReasoning(rawContent: string): {
	reasoning: string | null;
	content: string;
} {
	const m = rawContent.match(OWUI_REASONING_RE);
	if (!m) return { reasoning: null, content: rawContent };

	const content = rawContent.replace(OWUI_REASONING_RE, '').trim();

	let inner = m[1].replace(OWUI_SUMMARY_RE, '').trim();
	inner = decodeHtmlEntities(inner);
	// OWUI prefixes each line with markdown blockquote (`> `). Strip it so
	// the reasoning text reads naturally — the UI's reasoning component
	// styles it on its own.
	inner = inner
		.split('\n')
		.map((line) => line.replace(/^\s*>\s?/, ''))
		.join('\n')
		.trim();

	return { reasoning: inner.length > 0 ? inner : null, content };
}

/**
 * Minimal HTML entity decoder for the entities OWUI actually emits inside
 * `<details>` blocks (`&gt;`, `&quot;`, `&#x27;`, etc.). Order matters —
 * `&amp;` decodes last so we don't double-decode `&amp;gt;` to `>`.
 */
function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&amp;/g, '&');
}
