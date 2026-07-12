/**
 * Pure-ish helpers for turning our stored ChatMessage tree into the
 * `messages` array we send upstream. The image case still needs an async
 * media→dataURL resolver (so it's hard to test without mocks); the
 * tool_call / tool_result / text cases are pure and round-trip cleanly.
 *
 * Extracted so the serialization is unit-testable apart from the
 * SvelteKit request handler that drives it.
 */

import type { ChatMessage, MessagePart } from '$lib/types/api';
import { upstreamBranch } from '$lib/chat-compaction';
import { MediaNotAvailableError } from '$lib/server/media/data-url';
import { getMaxToolResultChars } from './config';
import type {
	ChatCompletionContentPart,
	ChatCompletionRequest,
	ChatCompletionRequestToolCall,
} from './client';

/** Resolve a stored media id to a data: URL the upstream can consume.
 *  Injected so tests don't need access to the media filesystem. */
export type MediaUrlResolver = (mediaId: string) => Promise<string>;

/** Concatenate just the text parts of a message — the cheap path when
 *  no images or tool calls are involved. */
export function partsToText(parts: MessagePart[]): string {
	return parts
		.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
		.map((p) => p.text)
		.join('');
}

/**
 * A text note naming a message's non-image file attachments (PDFs, CSVs,
 * spreadsheets, …), or '' if there are none. Without this the upstream model
 * never learns a file was attached: images ride the vision content array, but
 * `file` parts have no native wire representation, so they'd otherwise be
 * dropped — and the model can't act on (or even acknowledge) a file it was
 * never told about. The filenames match how `collectConversationFiles` mounts
 * them under `/workspace/`, so the model can reference them from run_python /
 * run_skill_script (whose tool descriptions explain the mount).
 */
export function fileAttachmentNote(parts: MessagePart[]): string {
	const files = parts.filter((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file');
	if (files.length === 0) return '';
	const names = files.map((f) => f.filename).join(', ');
	return `[Attached ${files.length === 1 ? 'file' : 'files'}: ${names}]`;
}

/** Pull the tool_call parts off an assistant message and reshape them
 *  into the OpenAI `tool_calls[]` wire format. */
function extractToolCalls(parts: MessagePart[]): ChatCompletionRequestToolCall[] {
	return parts
		.filter((p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call')
		.map((p) => ({
			id: p.toolCallId,
			type: 'function' as const,
			function: { name: p.toolName, arguments: p.arguments },
		}));
}

/**
 * Serialize one stored message into the upstream wire shape. Handles:
 *
 *  - `role: 'tool'` — picks the first `tool_result` part and emits
 *    `{ role:'tool', tool_call_id, content }` per OpenAI spec. Skips
 *    (returns null) when the message has no tool_result part, which
 *    shouldn't happen in practice but defensive.
 *  - `role: 'assistant'` with `tool_call` parts — emits a message with
 *    both `content` (any text parts) and `tool_calls`. `content` is
 *    null when the assistant emitted only tool calls (OpenAI accepts).
 *  - Messages with image parts — uses the vision-spec structured
 *    content array, inlining bytes as data URLs via `resolveMediaUrl`.
 *  - Everything else — bare-string content from concatenated text parts.
 */
export async function serializeMessageForUpstream(
	m: ChatMessage,
	resolveMediaUrl: MediaUrlResolver,
): Promise<ChatCompletionRequest['messages'][number] | null> {
	if (m.role === 'tool') {
		const result = m.parts.find(
			(p): p is Extract<MessagePart, { type: 'tool_result' }> => p.type === 'tool_result',
		);
		if (!result) return null;
		return {
			role: 'tool',
			content: result.result,
			tool_call_id: result.toolCallId,
		};
	}

	// A failed media branch persists as an assistant message carrying only an
	// `error` part (see MessagePart 'error'). It exists so a recovered fan-out /
	// reloaded thread can show the failure — but it has no upstream wire
	// representation, so drop it from the request rather than send an empty
	// assistant turn that would pollute the model's context.
	if (
		m.parts.some((p) => p.type === 'error') &&
		!m.parts.some((p) => p.type === 'text' || p.type === 'image' || p.type === 'tool_call')
	) {
		return null;
	}

	const toolCalls = m.role === 'assistant' ? extractToolCalls(m.parts) : [];
	const hasImages = m.parts.some((p) => p.type === 'image');
	const fileNote = fileAttachmentNote(m.parts);

	if (hasImages) {
		const content: ChatCompletionContentPart[] = [];
		let hasDeletedImage = false;
		for (const p of m.parts) {
			if (p.type === 'text' && p.text) {
				content.push({ type: 'text', text: p.text });
			} else if (p.type === 'image') {
				try {
					const url = await resolveMediaUrl(p.mediaId);
					content.push({ type: 'image_url', image_url: { url } });
				} catch (e) {
					// Known-dead media (hard-deleted, row gone, ENOENT) degrades to
					// a text note so the model knows something was attached rather
					// than crashing the entire send. Transient I/O errors (EACCES,
					// EIO, …) still propagate — see MediaNotAvailableError doc.
					if (e instanceof MediaNotAvailableError) {
						hasDeletedImage = true;
					} else {
						throw e;
					}
				}
			}
		}
		// Append a single note if any image was known-dead, so the model
		// knows something was there. Matches the fileAttachmentNote idiom.
		if (hasDeletedImage) content.push({ type: 'text', text: '[Image deleted]' });
		// Non-image attachments (files) get a text note so the model knows they
		// exist and can reference them by name (they're mounted in /workspace/).
		if (fileNote) content.push({ type: 'text', text: fileNote });
		const out: ChatCompletionRequest['messages'][number] = {
			role: m.role as 'system' | 'user' | 'assistant',
			content,
		};
		if (toolCalls.length > 0) out.tool_calls = toolCalls;
		return out;
	}

	const text = [partsToText(m.parts), fileNote].filter(Boolean).join('\n\n');

	if (toolCalls.length > 0) {
		// OpenAI permits null content alongside tool_calls when the
		// assistant spoke only via tools.
		return {
			role: 'assistant',
			content: text.length > 0 ? text : null,
			tool_calls: toolCalls,
		};
	}

	return {
		role: m.role as 'system' | 'user' | 'assistant',
		content: text,
	};
}

/** Opening marker of an `activate_skill` tool result — see `wrapSkillContent`
 *  in tools/activate-skill.ts. The captured group is the skill name. Requires
 *  the immediate `">` so it matches a full activation but NOT the placeholders
 *  below (whose tags carry an extra attribute first). That's what makes this
 *  pass idempotent. */
const SKILL_CONTENT_OPEN = /^<skill_content name="([^"]*)">/;

/** Stand-in for a redundant re-activation: the identical body is already in
 *  context, ABOVE. Points backward so the model uses what it already has instead
 *  of reading a silent gap and assuming the skill failed to load. */
function duplicateSkillPlaceholder(name: string): string {
	return (
		`<skill_content name="${name}" duplicate="true">\n` +
		`Already loaded. The full instructions for "${name}" appear earlier in this ` +
		`conversation and have not changed — use those.\n` +
		`</skill_content>`
	);
}

/** Stand-in for a STALE body: the skill was edited mid-conversation, so this
 *  copy is out of date and the current one is BELOW. Points forward. */
function supersededSkillPlaceholder(name: string): string {
	return (
		`<skill_content name="${name}" superseded="true">\n` +
		`These instructions were edited later in this conversation — see the ` +
		`most recent activation of "${name}" below for the current version.\n` +
		`</skill_content>`
	);
}

/**
 * Collapse duplicate skill activations in an already-serialized upstream
 * payload. When the same skill's full `<skill_content>` body appears more than
 * once in the model-visible view — the model re-activated it, or an explicit
 * `/skill-name` re-issued it — exactly one copy is kept in full and the rest
 * become compact placeholders. A skill body (up to 64 KiB) duplicated across a
 * long thread is otherwise dead weight resent on every subsequent request.
 *
 * WHICH copy is kept is a caching decision, and it is the whole point of this
 * function's shape: **the EARLIEST copy of the CURRENT body**.
 *
 * Both the keep-first and keep-last policies carry the same number of tokens —
 * one full body plus one stub either way, only the positions differ. But
 * keep-last rewrites the *earlier* message from 64 KiB down to a stub, and that
 * is a change in the MIDDLE of the prompt: the upstream's KV/prefix cache
 * diverges there and every token after it re-prefills. Keep-first leaves the
 * earlier message byte-identical and appends the stub at the tail, where the
 * tokens are new anyway — so a redundant re-activation costs nothing at all.
 *
 * Edits are still handled, and get the cache bust they actually deserve. If the
 * skill was edited between two activations, the current body first appears at
 * the post-edit activation, so that's the copy kept and the stale earlier ones
 * are superseded. The payload changes because the USER changed the skill — an
 * asked-for invalidation, not a gratuitous one (see CLAUDE.md on prefix
 * stability).
 *
 * Operates on the post-`upstreamBranch` wire array, which makes it inherently:
 *   - branch-aware — a sibling branch's activation isn't in this view;
 *   - compaction-safe — an activation folded into a summary is no longer here,
 *     so a later re-activation is correctly kept in full (the model lost the
 *     original instructions when they were summarized away).
 *
 * Persisted rows are untouched; this is a send-time transform recomputed each
 * request, so it's idempotent (placeholders don't match `SKILL_CONTENT_OPEN`).
 */
export function collapseSupersededSkillActivations(
	messages: ChatCompletionRequest['messages'],
): ChatCompletionRequest['messages'] {
	const skillName = (m: ChatCompletionRequest['messages'][number]): string | null =>
		m.role === 'tool' && typeof m.content === 'string'
			? (SKILL_CONTENT_OPEN.exec(m.content)?.[1] ?? null)
			: null;

	// Every full activation, grouped by skill name, in wire order.
	const indicesByName = new Map<string, number[]>();
	messages.forEach((m, i) => {
		const name = skillName(m);
		if (name === null) return;
		const at = indicesByName.get(name);
		if (at) at.push(i);
		else indicesByName.set(name, [i]);
	});

	// Nothing duplicated → return the array untouched (no allocation).
	if ([...indicesByName.values()].every((at) => at.length === 1)) return messages;

	// The index to keep in full, per skill: the earliest copy whose body matches
	// the newest one. Unchanged instructions → that's the FIRST activation, so the
	// prefix is never rewritten. Edited skill → it's the first post-edit copy.
	const keptByName = new Map<string, number>();
	for (const [name, at] of indicesByName) {
		const current = messages[at[at.length - 1]].content;
		keptByName.set(name, at.find((i) => messages[i].content === current) ?? at[at.length - 1]);
	}

	return messages.map((m, i) => {
		const name = skillName(m);
		if (name === null) return m;
		const kept = keptByName.get(name)!;
		if (i === kept) return m;
		// A copy BEFORE the kept one can only be a stale pre-edit body; one after it
		// is a redundant reload of what's already above. Point the model the right way
		// in each case — a placeholder that points the WRONG way is worse than none,
		// because it sends the model looking for instructions that aren't there.
		return {
			...m,
			content: i < kept ? supersededSkillPlaceholder(name) : duplicateSkillPlaceholder(name),
		};
	});
}

/**
 * Tools whose results are exempt from `capToolResults`.
 *
 * Both deliver content the model was explicitly directed to load, where a
 * truncation would silently corrupt the instructions rather than merely trim a
 * verbose answer: `activate_skill` returns the skill body (up to
 * MAX_SKILL_BODY_BYTES = 64 KiB — well over any sane cap), and `read_skill_file`
 * returns a bundled resource the skill's own instructions told it to open.
 *
 * Duplicate skill bodies are already handled, better, by
 * `collapseSupersededSkillActivations` — which drops the stale copies entirely
 * instead of cutting every copy off mid-sentence.
 */
const UNCAPPED_TOOLS: ReadonlySet<string> = new Set(['activate_skill', 'read_skill_file']);

/** The elision note for a whole (non-JSON) result. Roomy: it's spliced in once. */
function truncationNote(omitted: number): string {
	return `\n\n[... ${omitted.toLocaleString('en-US')} characters truncated. The full result is preserved in the conversation and visible to the user, but is too large to resend on every turn. Re-run the tool with a narrower query if you need the omitted part. ...]\n\n`;
}

/**
 * The elision note for one string leaf INSIDE a JSON result. Deliberately terse:
 * a list-shaped payload (60 `recall_memory` matches, say) has a note per leaf, and
 * at the long note's ~230 chars the notes alone would blow the entire cap — which
 * would send the whole thing down the character-slicing fallback and corrupt the
 * JSON we came here to protect.
 */
function leafNote(omitted: number): string {
	return `\n[... ${omitted.toLocaleString('en-US')} chars truncated ...]\n`;
}

/** Below this, a string leaf is treated as an identifier/label rather than bulk,
 *  and is never elided. See the filter in `truncateJsonResult` for why. */
const ELIDABLE_LEAF_MIN_CHARS = 120;

/** Slice without splitting a surrogate pair — a lone half is not valid text and
 *  renders as mojibake at the seam. */
function safeSlice(s: string, start: number, end: number): string {
	let a = start;
	let b = end;
	// A low surrogate at the start (or a high surrogate just before the end) means
	// the cut landed inside an astral character; step off it.
	if (a > 0 && a < s.length && s.charCodeAt(a) >= 0xdc00 && s.charCodeAt(a) <= 0xdfff) a += 1;
	if (b > 0 && b < s.length && s.charCodeAt(b - 1) >= 0xd800 && s.charCodeAt(b - 1) <= 0xdbff) {
		b -= 1;
	}
	return s.slice(a, Math.max(a, b));
}

/** Head + note + tail, keeping `keep` characters of `s` in total. */
function elide(s: string, keep: number, note: (omitted: number) => string): string {
	if (keep >= s.length) return s;
	const head = Math.ceil(keep * 0.7);
	const tail = keep - head;
	return (
		safeSlice(s, 0, head) +
		note(s.length - keep) +
		(tail > 0 ? safeSlice(s, s.length - tail, s.length) : '')
	);
}

/** Every string leaf of a parsed JSON value, with a setter, in a stable walk
 *  order (so truncation stays deterministic). */
interface StringLeaf {
	get: () => string;
	set: (v: string) => void;
}
function collectStringLeaves(node: unknown, out: StringLeaf[]): void {
	if (isRawNumber(node)) return; // a preserved number literal, not a string leaf
	if (Array.isArray(node)) {
		node.forEach((v, i) => {
			if (typeof v === 'string')
				out.push({ get: () => node[i] as string, set: (x) => (node[i] = x) });
			else collectStringLeaves(v, out);
		});
		return;
	}
	if (node !== null && typeof node === 'object') {
		const obj = node as Record<string, unknown>;
		for (const k of Object.keys(obj)) {
			const v = obj[k];
			if (typeof v === 'string')
				out.push({ get: () => obj[k] as string, set: (x) => (obj[k] = x) });
			else collectStringLeaves(v, out);
		}
	}
}

/** Serialized cost of a string leaf — what it contributes to the enclosing
 *  `JSON.stringify`, quotes and escapes included. */
function jsonLen(s: string): number {
	return JSON.stringify(s).length;
}

/**
 * Parse preserving NUMBER LITERALS exactly.
 *
 * A plain `JSON.parse` → `JSON.stringify` round-trip is lossy for numbers outside
 * IEEE-754 double range: an id of `12345678901234567890` comes back as
 * `12345678901234567000`, and `1e400` becomes `null`. Structural truncation
 * round-trips the whole payload, so a large numeric id in an over-cap result would
 * be silently rewritten — which is precisely the "corrupted id fed back to
 * forget_memory" failure class this file exists to prevent, just arriving through a
 * different door. Snowflake-style numeric ids from an MCP server are exactly this
 * shape.
 *
 * `JSON.rawJSON` (Node 22+; this project requires >=24 and ships on 26) lets the
 * reviver hand back the original source text, which `JSON.stringify` then emits
 * verbatim. Feature-guarded anyway: on a runtime without it we fall back to the
 * lossy-but-working round-trip rather than failing the send.
 *
 * Cost: the reviver boxes every number, which is ~8x slower on a number-DOMINATED
 * payload (a 1M-element int array: ~424ms vs ~54ms). Realistic tool results — prose
 * and rows — are ~1.1x, and this only runs on results already over the cap. Paying
 * that to stop a snowflake id being silently rounded is the right trade; it's noted
 * because it's send-path rent, not because it's free.
 */
/** `JSON.rawJSON` / source-carrying revivers are ES2025 (Node 22+). TypeScript's
 *  bundled lib doesn't declare them yet, so type the two we use rather than move
 *  the whole project's lib target for this. */
interface JsonWithRaw {
	rawJSON?: (text: string) => unknown;
	isRawJSON?: (v: unknown) => boolean;
	parse: (
		text: string,
		reviver?: (key: string, value: unknown, context?: { source?: string }) => unknown,
	) => unknown;
}
const RawJSON = JSON as unknown as JsonWithRaw;
const RAW_JSON_SUPPORTED = typeof RawJSON.rawJSON === 'function';

function parseJsonPreservingNumbers(text: string): unknown {
	if (!RAW_JSON_SUPPORTED) return JSON.parse(text);
	return RawJSON.parse(text, (_key, value, context) =>
		typeof value === 'number' && typeof context?.source === 'string'
			? RawJSON.rawJSON!(context.source)
			: value,
	);
}

/**
 * Deepest nesting we will structurally truncate. Beyond this the payload takes the
 * envelope instead.
 *
 * This bound is a DETERMINISM guarantee, not a taste judgement. V8 runs a
 * `JSON.parse` reviver through a JS-level recursion whose stack limit is far
 * shallower than the parser's own — and, crucially, whose headroom depends on how
 * deep the CALLER already is. Our own tree walkers recurse too. So without a bound,
 * the same payload at the same cap could truncate structurally when called from the
 * send path and fall back to a character slice when called from the (more deeply
 * nested) tool-approval resume or the context-breakdown endpoint. Same input, two
 * different outputs, decided by stack depth.
 *
 * That is CLAUDE.md's prefix-stability invariant broken exactly as written — "what
 * the user did may change the payload; timing must not" — and it would show up as
 * the breakdown pricing bytes the send path never sent, or a retry silently
 * re-prefilling the conversation.
 *
 * 100 is far above any real tool result (a JSON payload nested even 20 deep is
 * exotic) and far below the reviver's limit at any caller depth we could actually
 * reach: measured, a caller 3,000 frames deep still survives a JSON depth of ~1,878.
 * The guarantee isn't absolute — a caller within a few hundred frames of blowing the
 * stack outright (~12,400) could still diverge — but nothing in this codebase comes
 * within an order of magnitude of that, and such a caller is one call from dying
 * anyway. The old bug fired across ordinary depths (0–1,500); this one needs a stack
 * already 96% spent.
 */
const MAX_JSON_DEPTH = 100;

/**
 * Maximum bracket nesting of a JSON document, read straight off the TEXT — no
 * parsing, no recursion, and therefore no stack of its own. String-aware, so
 * brackets inside string values don't count.
 */
function jsonNestingDepth(text: string): number {
	let depth = 0;
	let max = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '{' || c === '[') {
			if (++depth > max) max = depth;
		} else if (c === '}' || c === ']') depth--;
	}
	return max;
}

/** A `JSON.rawJSON` box is an object, so the tree walkers must not descend into it
 *  and mistake its `rawJSON` field for a truncatable string leaf. */
function isRawNumber(node: unknown): boolean {
	return RAW_JSON_SUPPORTED && RawJSON.isRawJSON!(node);
}

/** Every array in the tree, largest (most elements) first. Ties keep walk order,
 *  so the choice stays deterministic. */
function collectArrays(node: unknown, out: unknown[][]): void {
	if (isRawNumber(node)) return;
	if (Array.isArray(node)) {
		out.push(node);
		for (const v of node) collectArrays(v, out);
		return;
	}
	if (node !== null && typeof node === 'object') {
		for (const k of Object.keys(node as Record<string, unknown>)) {
			collectArrays((node as Record<string, unknown>)[k], out);
		}
	}
}

/**
 * Stage 1 of the ladder: shrink the bulky string leaves so the whole fits.
 * Mutates `root` on success; restores it exactly on failure.
 *
 * The budget arithmetic is EXACT and needs only two full stringifies, because a
 * `JSON.stringify` length is additive in its leaves: replacing one leaf's value
 * changes the total by exactly the change in that leaf's own serialized cost.
 * So: serialize once with every elidable leaf at its floor (note only), and the
 * slack is `maxChars - floorLength`. Each leaf is then priced on its own with
 * `jsonLen`, never by re-serializing the payload.
 *
 * The first cut of this called `JSON.stringify(root)` INSIDE a per-leaf binary
 * search — ~13 full serializations per leaf, for every leaf. On an 850 KB
 * many-leaf result that blocked the (single) Node process for 4.6 SECONDS, and
 * the payloads it worked hardest on were exactly the ones it then gave up on. On
 * a self-hosted box that stall is a worse failure than the corrupt JSON this was
 * curing.
 *
 * Leaves are filled HEAD-first: a ranked list puts its best results first, so the
 * head is what's worth keeping and the tail degrades to a note.
 */
function fitByElidingLeaves(root: unknown, leaves: StringLeaf[], maxChars: number): boolean {
	const originals = leaves.map((l) => l.get());
	const restore = () => leaves.forEach((l, i) => l.set(originals[i]));

	// Floor: every elidable leaf reduced to its note. Nothing else can be given up.
	const notes = originals.map((s) => leafNote(s.length));
	leaves.forEach((l, i) => l.set(notes[i]));
	const floorLength = JSON.stringify(root).length;
	if (floorLength > maxChars) {
		restore();
		return false; // even the floor is too big — try dropping records instead
	}

	let budget = maxChars - floorLength;
	for (let i = 0; i < leaves.length && budget > 0; i++) {
		const original = originals[i];
		const noteCost = jsonLen(notes[i]);

		// Cheapest case: it fits whole.
		const fullCost = jsonLen(original);
		if (fullCost - noteCost <= budget) {
			leaves[i].set(original);
			budget -= fullCost - noteCost;
			continue;
		}

		// Otherwise find the most of it we can afford. Each probe prices only THIS
		// leaf, so the search is O(leaf), not O(payload).
		let lo = 0;
		let hi = original.length;
		let best = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (jsonLen(elide(original, mid, leafNote)) - noteCost <= budget) {
				best = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		if (best >= 0) {
			const kept = elide(original, best, leafNote);
			leaves[i].set(kept);
			budget -= jsonLen(kept) - noteCost;
		}
		// Budget is spent; every later leaf stays at its floor note.
		break;
	}

	if (JSON.stringify(root).length <= maxChars) return true;
	restore();
	return false;
}

/** Marker left in place of the array elements that were dropped. */
function droppedItemsMarker(n: number): string {
	return `[... ${n.toLocaleString('en-US')} more items truncated — re-run with a narrower query for the rest ...]`;
}

/**
 * Stage 2: the payload's bulk is RECORDS, not prose — a big array of small rows,
 * which is the single most plausible shape for an oversized MCP result. No amount
 * of leaf-eliding helps (there are no bulky leaves, and each row's note costs more
 * than the row saves), so drop rows from the tail instead and say how many went.
 *
 * Keeps whole records rather than shredding every one of them, which is the point:
 * a half-truncated id that a model then feeds to `forget_memory` is exactly the
 * misfire this file exists to prevent.
 */
function fitByDroppingArrayTail(root: unknown, maxChars: number): boolean {
	const arrays: unknown[][] = [];
	collectArrays(root, arrays);
	const target = arrays.sort((a, b) => b.length - a.length)[0];
	if (!target || target.length < 2) return false;

	const original = [...target];
	const n = original.length;

	// NEVER `push(...arr)` here. Spread-into-call passes one argument per element,
	// so a large array blows the argument/stack limit outright: a 2 MB result of
	// 300k numbers threw `RangeError: Maximum call stack size exceeded` — from
	// inside `capToolResults`, i.e. on the SEND path, not merely the panel. Write
	// through indices instead; it is bounded by nothing.
	const keepPrefix = (k: number, marker: string | null): void => {
		target.length = 0;
		for (let i = 0; i < k; i++) target[i] = original[i];
		if (marker !== null) target[k] = marker;
	};

	// Same additivity trick as stage 1, one level up: an array's serialized length
	// is its elements' costs plus the separators, so the whole payload can be priced
	// for ANY k from one full stringify plus a prefix sum — rather than
	// re-serializing megabytes on each of ~18 binary-search probes.
	//
	//   total(k) = emptyLength + prefix[k] + k + markerCost(k)
	//
	// where `emptyLength` is the payload with this array emptied, `prefix[k]` the
	// summed cost of the first k elements, `k` the commas between k elements and the
	// marker, and `markerCost(k)` the marker's own quoted length (which varies with
	// the digits of the dropped count).
	keepPrefix(0, null);
	const emptyLength = JSON.stringify(root).length;

	const prefix = new Array<number>(n + 1);
	prefix[0] = 0;
	for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + JSON.stringify(original[i]).length;

	const totalFor = (k: number) => emptyLength + prefix[k] + k + jsonLen(droppedItemsMarker(n - k));

	let lo = 0;
	let hi = n - 1;
	let best = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (totalFor(mid) <= maxChars) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}

	if (best < 0) {
		keepPrefix(n, null); // restore untouched
		return false;
	}
	keepPrefix(best, droppedItemsMarker(n - best));
	// Belt and braces: the arithmetic above is exact, but a mistake here would ship
	// an over-cap payload rather than a visibly broken one.
	if (JSON.stringify(root).length <= maxChars) return true;
	keepPrefix(n, null);
	return false;
}

/**
 * Stage 3: the structure itself is irreducible. Rather than character-slicing —
 * which is what produced invalid JSON in the first place — emit a small, honest,
 * always-valid envelope carrying a preview.
 */
function truncationEnvelope(result: string, maxChars: number): string | null {
	const build = (preview: string) =>
		JSON.stringify({
			truncated: true,
			original_chars: result.length,
			note: 'This result was too large to resend on every turn. The full version is preserved in the conversation and visible to the user. Re-run the tool with a narrower query if you need it.',
			preview,
		});
	if (build('').length > maxChars) return null; // cap too tight even for this

	let lo = 0;
	let hi = result.length;
	let best = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (build(safeSlice(result, 0, mid)).length <= maxChars) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return build(safeSlice(result, 0, best));
}

/**
 * Truncate a JSON tool result *structurally*, so the output is still parseable
 * JSON. Returns null ONLY when the input isn't JSON, or when the cap is too tight
 * for even the smallest valid envelope (~243 chars — see `max_tool_result_chars`,
 * whose minimum is enforced well above that). In both of those cases the caller
 * falls back to a text elision, which is the only thing left.
 *
 * This is why the cap can't just slice characters: EVERY built-in tool emits
 * `JSON.stringify(...)` (fetch_url, web_search, run_python, recall_memory,
 * search_conversations), and a blind cut lands mid-escape or mid-record. Shrinking
 * the value and re-stringifying keeps the envelope intact and lets `JSON.stringify`
 * regenerate the escaping.
 *
 * A ladder, degrading only as far as it must:
 *   1. elide the bulky string leaves (prose payloads — the common case);
 *   2. drop tail records from the biggest array (row payloads — big MCP results);
 *   3. an honest envelope with a preview — for irreducible structure, for every
 *      JSON scalar (a bare number can't be "shortened" and stay a number), and for
 *      anything nested past MAX_JSON_DEPTH.
 * Within a workable cap, valid JSON in yields valid JSON out — every rung of the
 * ladder, including the last, emits parseable JSON.
 */
function truncateJsonResult(result: string, maxChars: number): string | null {
	// Bound the nesting BEFORE parsing. Both the reviver and the tree walkers below
	// recurse, and their stack headroom depends on the caller's depth — so on a
	// pathologically nested payload the output would otherwise depend on WHO called
	// us (send path vs. tool-approval resume vs. context endpoint). See MAX_JSON_DEPTH.
	// The envelope is always-valid JSON and needs no parse, so it's the safe answer.
	const head = result.trimStart();
	if ((head.startsWith('{') || head.startsWith('[')) && jsonNestingDepth(result) > MAX_JSON_DEPTH) {
		return truncationEnvelope(result, maxChars);
	}

	let parsed: unknown;
	try {
		// Preserves number literals exactly; see parseJsonPreservingNumbers.
		parsed = parseJsonPreservingNumbers(result);
	} catch {
		return null; // not JSON — caller falls back to a text elision
	}

	// A bare JSON string (no built-in emits one today, but MCP servers may) is a
	// single leaf with no envelope: price the QUOTED form directly, since the
	// escaping is the whole difference between it fitting and not.
	if (typeof parsed === 'string') {
		let lo = 0;
		let hi = parsed.length;
		let best = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (jsonLen(elide(parsed, mid, truncationNote)) <= maxChars) {
				best = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		if (best >= 0) return JSON.stringify(elide(parsed, best, truncationNote));
		return truncationEnvelope(result, maxChars);
	}

	// Any other bare scalar — a number, a boolean, `null`, or a preserved raw
	// number. There's no way to "shorten" a numeric literal and have it still be
	// that number, so character-slicing one would splice a prose note into the
	// middle of a digit string. The envelope is the only honest answer.
	if (parsed === null || typeof parsed !== 'object' || isRawNumber(parsed)) {
		return truncationEnvelope(result, maxChars);
	}

	const all: StringLeaf[] = [];
	collectStringLeaves(parsed, all);
	// Only BULKY leaves are elidable. Short ones are identifiers and metadata — an
	// `id`, a `topic`, a `url`, a status string — and cutting them is pure damage:
	// a model that reads a half-truncated memory id and then passes it to
	// forget_memory is exactly the misfire this whole change exists to prevent.
	// (Below the floor there's nothing to win anyway: the note costs ~30 chars.)
	const leaves = all.filter((l) => l.get().length > ELIDABLE_LEAF_MIN_CHARS);

	if (leaves.length > 0 && fitByElidingLeaves(parsed, leaves, maxChars)) {
		return JSON.stringify(parsed);
	}
	if (fitByDroppingArrayTail(parsed, maxChars)) return JSON.stringify(parsed);
	return truncationEnvelope(result, maxChars);
}

/**
 * Bound a single tool result's contribution to the payload.
 *
 * A tool result is re-sent verbatim on every subsequent turn of the branch, so
 * one `fetch_url` against a 200 KB page isn't a one-off — it's ~50k tokens of
 * permanent rent for the rest of the conversation, and compaction can't reach it
 * until the turn is old enough to fold. This caps what goes upstream. The full
 * result stays in the database and stays visible in the UI; only the model's copy
 * is trimmed.
 *
 * JSON results — which is to say nearly all of them — are truncated STRUCTURALLY:
 * parse, shrink the biggest string leaves, re-stringify. A blind character slice
 * cuts through `\uXXXX` escapes and half-way through records, and the result stops
 * being parseable JSON at all. Nothing in the loop parses it (the HTTP body is
 * re-stringified downstream), so it wasn't a crash — but a model reading a
 * half-truncated memory id out of a `recall_memory` list and then passing it to
 * `forget_memory` is a very plausible misfire.
 *
 * Non-JSON falls back to a head+tail character elision (surrogate-safe): the head
 * carries the shape of the result and the tail is where errors and totals live, so
 * head-only truncation reliably loses the punchline.
 *
 * Deterministic on purpose — the same result yields the same bytes on every turn.
 * An age-based scheme (trim older results harder as the thread grows) would save
 * more, but it rewrites the middle of the prompt on every turn and so invalidates
 * the upstream's KV/prefix cache for the entire conversation. Not worth it.
 */
export function truncateToolResult(result: string, maxChars: number): string {
	if (maxChars <= 0 || result.length <= maxChars) return result;

	const structured = truncateJsonResult(result, maxChars);
	if (structured !== null) return structured;

	// Plain text. Sizing the budget is mildly self-referential: the note reports how
	// much was dropped, and the note itself occupies budget, so a bigger note means a
	// smaller keep means a bigger reported number — which can tick over a digit
	// boundary and push the result 1-2 chars past the cap. Converge instead of
	// guessing (it settles on the first or second pass).
	let budget = maxChars - truncationNote(result.length - maxChars).length;
	for (let i = 0; i < 4 && budget > 0; i++) {
		const out = elide(result, budget, truncationNote);
		if (out.length <= maxChars) return out;
		budget -= out.length - maxChars;
	}
	// Cap so tight the note alone won't fit → a bare head is the best we can do.
	return safeSlice(result, 0, maxChars);
}

/**
 * Cap oversized tool results across an already-serialized upstream payload.
 *
 * Operates on the wire array (like `collapseSupersededSkillActivations`) and
 * rebuilds the tool-call-id → tool-name mapping from the assistant turns in it,
 * because the persisted `tool_result` part carries only the call id. That keeps
 * the exemption list keyed on the actual TOOL rather than on sniffing the result's
 * content, and needs no extra plumbing from the caller.
 *
 * Branch- and compaction-aware for free, for the same reason the collapse pass is:
 * it only ever sees the model-visible view.
 */
export function capToolResults(
	messages: ChatCompletionRequest['messages'],
	maxChars: number,
): ChatCompletionRequest['messages'] {
	if (maxChars <= 0) return messages;

	const toolNameByCallId = new Map<string, string>();
	for (const m of messages) {
		for (const call of m.tool_calls ?? []) {
			toolNameByCallId.set(call.id, call.function.name);
		}
	}

	let changed = false;
	const out = messages.map((m) => {
		if (m.role !== 'tool' || typeof m.content !== 'string') return m;
		if (m.content.length <= maxChars) return m;

		const name = m.tool_call_id ? toolNameByCallId.get(m.tool_call_id) : undefined;
		if (name && UNCAPPED_TOOLS.has(name)) return m;
		// Belt-and-braces: a skill body whose originating assistant turn isn't in
		// this view (so the id → name lookup came up empty) is still recognizable by
		// its wrapper, and cutting a 64 KiB instruction block off mid-sentence is
		// exactly the failure this pass must never cause.
		if (SKILL_CONTENT_OPEN.test(m.content)) return m;

		changed = true;
		return { ...m, content: truncateToolResult(m.content, maxChars) };
	});
	return changed ? out : messages;
}

/**
 * Serialize an entire branch (root → active leaf) into the upstream
 * messages array, prepending the optional system prompt. Filters out
 * any messages that serialize to null (defensive), then applies the wire
 * transforms — see `applyWireTransforms`.
 *
 * If the branch has been compacted, `upstreamBranch` trims it to
 * `[latest summary, ...verbatim tail + later turns]` — the summary stands in
 * for the older history that's still kept in the DB but not resent. This is
 * the single choke point through which every send path (initial send, mid-turn
 * tool rebuild, tool-approval resume) inherits the trim. (The compaction engine
 * itself does NOT go through here — it serializes its own slice per-message so
 * it can summarize the very history this would drop.)
 */
export async function serializeBranchForUpstream(
	branch: ChatMessage[],
	resolveMediaUrl: MediaUrlResolver,
	systemPrompt: string | null,
): Promise<ChatCompletionRequest['messages']> {
	const out: ChatCompletionRequest['messages'] = [];
	if (systemPrompt) {
		out.push({ role: 'system', content: systemPrompt });
	}
	for (const m of upstreamBranch(branch)) {
		const serialized = await serializeMessageForUpstream(m, resolveMediaUrl);
		if (serialized) out.push(serialized);
	}
	return applyWireTransforms(out);
}

/**
 * The send-time transforms every upstream payload gets, in order: drop stale
 * skill bodies, then cap oversized tool results.
 *
 * Shared by the send path and by the context breakdown, so the panel measures
 * what the model is actually handed. Both are recomputed per request from
 * persisted rows (nothing is mutated), and both are deterministic — the same
 * branch produces the same bytes every turn, which is what keeps the upstream's
 * prefix cache valid across a conversation.
 */
export function applyWireTransforms(
	messages: ChatCompletionRequest['messages'],
	maxToolResultChars: number = getMaxToolResultChars(),
): ChatCompletionRequest['messages'] {
	return capToolResults(collapseSupersededSkillActivations(messages), maxToolResultChars);
}
