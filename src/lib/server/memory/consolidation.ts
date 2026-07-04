/**
 * The memory-consolidation LLM step for the dreaming worker: hand the memory
 * model a user's live memories, get back a set of structured operations, and
 * validate them. Applying the ops (soft-delete/update in a transaction) is the
 * worker's job — this module is prompt + parse + validate only.
 *
 * There is no JSON-mode / `response_format` in the client, so (like every other
 * utility task) we prompt for a JSON object and parse-and-validate the freeform
 * `content` defensively: malformed output yields zero ops rather than throwing,
 * and any individual op that references unknown/duplicate ids or over-long text
 * is dropped. Combined with soft-delete, that's the safety net around a
 * background model mutating user facts.
 *
 * Operation hierarchy (encoded in the prompt) — prune is a genuine last resort:
 *   merge → merge-supersede (keep history) → distill-to-durable → retopic → prune.
 */

import { chatCompletionSync } from '../endpoints/client';
import type { ResolvedMemoryModel } from '../tasks/memory-model';

// Match the caps the save_memory tool enforces, so a consolidated memory renders
// at the same scale as a model-authored one.
const MAX_CONTENT_CHARS = 500;
const MAX_TOPIC_CHARS = 80;

export interface MemoryForConsolidation {
	id: string;
	content: string;
	topic: string | null;
}

export type ConsolidationOp =
	| { type: 'merge'; ids: string[]; content: string; topic: string }
	| { type: 'reword'; id: string; content: string; topic: string }
	| { type: 'retopic'; id: string; topic: string }
	| { type: 'prune'; id: string; reason: string };

const SYSTEM_PROMPT = `You are the librarian of a user's long-term memory — a set of durable facts an assistant recalls across conversations. Your job is to tidy it WITHOUT losing information. You return a JSON object of edit operations; be conservative and leave anything you're unsure about untouched.

Operations, in order of preference:
1. "merge" — combine two or more memories that state the same fact (duplicates, or one subsuming another) into a single clear memory. Preserve every distinct detail.
2. "reword" a superseded fact into a current+previous form rather than dropping the old one. E.g. "works at Acme" + "started at Globex" → one memory: "Works at Globex; previously at Acme." Keep the history.
3. "reword" (distill) an ephemeral or time-bound memory into its lasting residue. Before removing anything, always ask: "can this be reworded into something durably valuable?" E.g. "planning a trip to Japan in March" → "Has researched travel in Japan and has some familiarity with it." Only its transient framing is dropped; the durable signal is kept.
4. "retopic" — fix an inaccurate or inconsistent topic label (leaves the content unchanged).
5. "prune" — a LAST RESORT, only when a memory has no durable value that any reword could preserve (e.g. a fact fully contradicted by a newer one, with nothing worth keeping).

Rules:
- Only reference the memory ids given below. Use each memory id in at most ONE operation.
- Keep merged/reworded "content" to one self-contained sentence (max ${MAX_CONTENT_CHARS} chars) and "topic" to a few words (max ${MAX_TOPIC_CHARS} chars).
- When in doubt, do nothing — an empty operations list is a perfectly good answer.
- Output ONLY the JSON object, no prose, no code fences.

Schema:
{"operations":[
  {"type":"merge","ids":["id1","id2"],"content":"...","topic":"..."},
  {"type":"reword","id":"id1","content":"...","topic":"..."},
  {"type":"retopic","id":"id1","topic":"..."},
  {"type":"prune","id":"id1","reason":"..."}
]}`;

/**
 * Ask the memory model to consolidate a user's memories. Returns the validated
 * ops (possibly empty). Lets an upstream error propagate — the worker decides
 * retry. `model`, endpoint + slot are the caller's concern; this just calls
 * `chatCompletionSync` and validates.
 */
export async function proposeConsolidation(
	model: ResolvedMemoryModel,
	memories: MemoryForConsolidation[],
	signal?: AbortSignal,
): Promise<ConsolidationOp[]> {
	if (memories.length < 2) return []; // nothing to consolidate against
	const resp = await chatCompletionSync(
		model.endpoint,
		{
			model: model.upstreamId,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: renderMemories(memories) },
			],
			max_tokens: model.maxTokens,
			temperature: model.temperature,
		},
		signal,
	);
	const raw = resp.choices?.[0]?.message?.content ?? '';
	return parseConsolidation(raw, new Set(memories.map((m) => m.id)));
}

/** Wrap the memory list as data — `[id] (topic) content` lines in <memories>. */
export function renderMemories(memories: MemoryForConsolidation[]): string {
	const lines = memories.map((m) => `[${m.id}] (${m.topic ?? 'no topic'}) ${m.content}`);
	return `<memories>\n${lines.join('\n')}\n</memories>\n\nReturn the JSON operations object.`;
}

/**
 * Parse + validate the model's JSON into `ConsolidationOp[]`. Defensive: bad
 * JSON → `[]`; each op is dropped unless it type-checks, references only ids in
 * `validIds`, uses each id at most once across the whole batch, and stays within
 * the content/topic caps. Exported for testing.
 */
export function parseConsolidation(raw: string, validIds: Set<string>): ConsolidationOp[] {
	const obj = tryParseJson(raw);
	if (!obj || typeof obj !== 'object') return [];
	const list = (obj as { operations?: unknown }).operations;
	if (!Array.isArray(list)) return [];

	const out: ConsolidationOp[] = [];
	const used = new Set<string>();
	for (const item of list) {
		const op = validateOp(item, validIds, used);
		if (!op) continue;
		for (const id of opIds(op)) used.add(id);
		out.push(op);
	}
	return out;
}

function validateOp(
	item: unknown,
	validIds: Set<string>,
	used: Set<string>,
): ConsolidationOp | null {
	if (!item || typeof item !== 'object') return null;
	const o = item as Record<string, unknown>;
	const known = (id: unknown): id is string =>
		typeof id === 'string' && validIds.has(id) && !used.has(id);
	const content = capped(o.content, MAX_CONTENT_CHARS);
	const topic = capped(o.topic, MAX_TOPIC_CHARS);

	switch (o.type) {
		case 'merge': {
			if (!Array.isArray(o.ids) || o.ids.length < 2) return null;
			if (!o.ids.every(known)) return null;
			if (new Set(o.ids).size !== o.ids.length) return null; // no repeats within the op
			if (!content || !topic) return null;
			return { type: 'merge', ids: o.ids as string[], content, topic };
		}
		case 'reword':
			if (!known(o.id) || !content || !topic) return null;
			return { type: 'reword', id: o.id, content, topic };
		case 'retopic':
			if (!known(o.id) || !topic) return null;
			return { type: 'retopic', id: o.id, topic };
		case 'prune':
			if (!known(o.id)) return null;
			return { type: 'prune', id: o.id, reason: typeof o.reason === 'string' ? o.reason : '' };
		default:
			return null;
	}
}

function opIds(op: ConsolidationOp): string[] {
	return op.type === 'merge' ? op.ids : [op.id];
}

/** Trim + cap a string field; returns '' when missing/blank (an invalid value). */
function capped(v: unknown, max: number): string {
	if (typeof v !== 'string') return '';
	const t = v.trim();
	return t.length === 0 || t.length > max ? '' : t;
}

/** Parse JSON, tolerating markdown fences / surrounding prose by falling back to
 *  the outermost `{...}` slice. Returns null on failure. */
function tryParseJson(raw: string): unknown {
	const stripped = raw.replace(/```(?:json)?/gi, '').trim();
	try {
		return JSON.parse(stripped);
	} catch {
		const start = stripped.indexOf('{');
		const end = stripped.lastIndexOf('}');
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(stripped.slice(start, end + 1));
			} catch {
				return null;
			}
		}
		return null;
	}
}
