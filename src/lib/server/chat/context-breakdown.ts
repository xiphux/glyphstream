/**
 * Prices the upstream request, segment by segment.
 *
 * `chat-compaction.ts` has long carried the note that compaction "only shrinks
 * the message history — not the system prompt, tool definitions, or saved
 * memories, which are re-sent every turn", and that `MIN_COMPACTIBLE_TOKENS`
 * exists purely as a proxy for not knowing how big that overhead is. This module
 * is the missing measurement: it rebuilds exactly what the next send would carry
 * and attributes every character to a segment, so "compacting won't help, your
 * overhead is the problem" becomes something we can show rather than guess.
 *
 * It deliberately drives the REAL serializer (`serializeMessageForUpstream` +
 * `collapseSupersededSkillActivations`) rather than re-walking `ChatMessage.parts`
 * itself. A parallel implementation would drift from the wire the first time the
 * serialization changed, and drift is precisely what makes an instrument
 * worthless. The one substitution is the media resolver: images are priced from
 * the `byte_size` column instead of being read off disk and base64'd, since the
 * whole point is to be cheap enough to call from a UI panel.
 */
import type {
	ChatMessage,
	ContextBreakdown,
	ContextSegment,
	ContextSegmentKey,
} from '$lib/types/api';
import { upstreamBranch, isCompactionSummary } from '$lib/chat-compaction';
import type { OpenAIToolDefinition } from '../tools/types';
import type { PersonaPart } from '../db/queries/user-preferences';
import type { ChatCompletionRequest } from '../endpoints/client';
import {
	applyWireTransforms,
	serializeMessageForUpstream,
	type MediaUrlResolver,
} from '../endpoints/serialize-upstream';

/**
 * Stand-in a sizing resolver returns instead of a real data URL. Carries the
 * media id so the measured `image_url` can be priced from the DB row rather than
 * from megabytes of base64 we'd otherwise have to build just to call `.length`
 * on. A real resolver only ever returns a `data:` URL, so this scheme can't collide.
 */
const MEDIA_SENTINEL = 'gs-media://';

/** The codebase-wide estimate (see `estimateContentTokens`). No tokenizer exists
 *  server-side either; the upstream's reported `prompt_tokens` is the only real
 *  number, and the breakdown surfaces it alongside rather than pretending. */
function estTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

/** Wire length of `data:<contentType>;base64,<...>` for a blob of `bytes`,
 *  without materializing the base64. */
export function dataUrlChars(bytes: number, contentType: string): number {
	return `data:${contentType};base64,`.length + Math.ceil(bytes / 3) * 4;
}

/** What the breakdown needs to know about an image to price it: the bytes that
 *  will actually be inlined, and the type they'll be inlined as. */
export interface MediaSize {
	byteSize: number;
	contentType: string;
}

export interface ContextBreakdownInput {
	/** The full active branch (root → leaf). Trimmed to the model-visible view
	 *  internally, so a compacted thread prices what it actually sends. */
	branch: ChatMessage[];
	/** Persona sections, from `composePersonaPromptParts`. Empty when
	 *  personalization is sealed or the conversation snapshotted its own prompt. */
	personaParts: readonly PersonaPart[];
	/** A custom-model conversation's snapshotted `meta.systemPrompt`, which
	 *  replaces the persona prompt outright. */
	customSystemPrompt: string | null;
	/** The unconditional environment preamble (today's date). */
	environmentBlock: string;
	skillsCatalog: string | null;
	toolSearchHint: string | null;
	toolDefs: readonly OpenAIToolDefinition[];
	/** The canvas tail block(s) appended at send time (`buildCanvasInjection`),
	 *  or null. Re-sent verbatim every turn, so it's overhead — priced on its own
	 *  `canvas` line. The `update_canvas` def rides `toolDefs` like any tool. */
	canvasTailText?: string | null;
	/**
	 * The bytes an image actually contributes — its downscaled vision variant
	 * where one has been generated, NOT the original on disk. Pricing the original
	 * would overstate a 4 MB photo by an order of magnitude now that it isn't the
	 * thing being sent.
	 *
	 * Null for media that's been hard-deleted or is otherwise unavailable: the
	 * serializer degrades those to an `[Image deleted]` note, and so does this.
	 */
	mediaSize: (mediaId: string) => Promise<MediaSize | null>;
	contextWindow: number | null;
}

export async function buildContextBreakdown(
	input: ContextBreakdownInput,
): Promise<ContextBreakdown> {
	const acc = new SegmentAccumulator();

	// --- Overhead: re-sent verbatim on every turn, untouchable by compaction.
	acc.add('system:environment', input.environmentBlock.length);
	if (input.customSystemPrompt) {
		acc.add('system:custom', input.customSystemPrompt.length);
	}
	for (const part of input.personaParts) {
		acc.add(part.key, part.text.length);
	}
	if (input.skillsCatalog) acc.add('skills:catalog', input.skillsCatalog.length);
	if (input.toolSearchHint) acc.add('tools:hint', input.toolSearchHint.length);
	for (const def of input.toolDefs) {
		acc.add('tools:defs', JSON.stringify(def).length, def.function.name);
	}
	if (input.canvasTailText) acc.add('canvas', input.canvasTailText.length);

	// --- History: what compaction can actually reclaim.
	const imageBytes = await priceHistory(input, acc);

	const segments = acc.segments();
	return {
		segments,
		estimatedTokens: segments.reduce((n, s) => n + s.tokens, 0),
		reportedPromptTokens: lastReportedPromptTokens(input.branch),
		imageBytes,
		contextWindow: input.contextWindow,
	};
}

/**
 * Serialize the model-visible branch through the real wire path and attribute
 * each message's characters to a segment. Returns the total image bytes.
 *
 * The pairing between a source `ChatMessage` and its wire form matters: the role
 * and the is-this-a-summary bit live on the source, the post-collapse content
 * lives on the wire. `serializeMessageForUpstream` can drop a message (returning
 * null), and `collapseSupersededSkillActivations` is an index-preserving `.map()`
 * — so filtering the nulls out of BOTH arrays first keeps the two aligned.
 */
async function priceHistory(
	input: ContextBreakdownInput,
	acc: SegmentAccumulator,
): Promise<number> {
	const resolve: MediaUrlResolver = async (mediaId) => MEDIA_SENTINEL + mediaId;
	const view = upstreamBranch(input.branch);

	const pairs: { src: ChatMessage; wire: ChatCompletionRequest['messages'][number] }[] = [];
	for (const src of view) {
		const wire = await serializeMessageForUpstream(src, resolve);
		if (wire) pairs.push({ src, wire });
	}

	// The same transforms the send path applies (stale skill bodies dropped,
	// oversized tool results capped) — so the panel prices the payload the model
	// gets, not the payload before send-time trimming. Both are index-preserving
	// `.map()`s, which is what keeps `pairs[i]` aligned with `wire[i]`.
	const wireMessages = applyWireTransforms(pairs.map((p) => p.wire));
	let imageBytes = 0;

	for (const [i, { src }] of pairs.entries()) {
		const wire = wireMessages[i];

		// A tool result is its own segment regardless of what's in it — these are
		// the rows that get resent verbatim forever and never shrink.
		if (wire.role === 'tool') {
			acc.add('history:tool_results', wireChars(wire.content));
			continue;
		}

		for (const call of wire.tool_calls ?? []) {
			acc.add(
				'history:tool_calls',
				call.function.name.length + call.function.arguments.length,
				call.function.name,
			);
		}

		// The summary stands in for everything it folded, so it belongs on its own
		// line — it's overhead the user chose, not history they can compact again.
		const textKey: ContextSegmentKey = isCompactionSummary(src)
			? 'history:summary'
			: 'history:text';

		if (typeof wire.content === 'string') {
			acc.add(textKey, wire.content.length);
		} else if (Array.isArray(wire.content)) {
			for (const part of wire.content) {
				if (part.type === 'text') {
					acc.add(textKey, part.text.length);
					continue;
				}
				const mediaId = part.image_url.url.startsWith(MEDIA_SENTINEL)
					? part.image_url.url.slice(MEDIA_SENTINEL.length)
					: null;
				const size = mediaId ? await input.mediaSize(mediaId) : null;
				if (!size) continue;
				imageBytes += size.byteSize;
				acc.add('history:images', dataUrlChars(size.byteSize, size.contentType), mediaId ?? '?');
			}
		}
	}

	return imageBytes;
}

/** Characters a wire `content` field contributes. Null content (an assistant turn
 *  that spoke only through tool calls) costs nothing. */
function wireChars(content: ChatCompletionRequest['messages'][number]['content']): number {
	if (typeof content === 'string') return content.length;
	if (!Array.isArray(content)) return 0;
	return content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
}

/**
 * `prompt_tokens` from the most recent completed assistant turn — the last
 * authoritative measurement the upstream gave us. Skips summaries (whose usage
 * describes the summarization call, not this conversation) and turns that
 * reported nothing.
 */
function lastReportedPromptTokens(branch: ChatMessage[]): number | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i];
		if (m.role !== 'assistant' || isCompactionSummary(m)) continue;
		if (m.tokensIn && m.tokensIn > 0) return m.tokensIn;
	}
	return null;
}

/** Folds repeated `add` calls into one segment per key, tracking the per-item
 *  costs so the UI can name the three tools eating half the overhead. */
class SegmentAccumulator {
	#chars = new Map<ContextSegmentKey, number>();
	#items = new Map<ContextSegmentKey, Map<string, number>>();

	add(key: ContextSegmentKey, chars: number, item?: string): void {
		if (chars <= 0) return;
		this.#chars.set(key, (this.#chars.get(key) ?? 0) + chars);
		if (item === undefined) return;
		const items = this.#items.get(key) ?? new Map<string, number>();
		items.set(item, (items.get(item) ?? 0) + chars);
		this.#items.set(key, items);
	}

	segments(): ContextSegment[] {
		const out: ContextSegment[] = [];
		for (const [key, chars] of this.#chars) {
			// Images are wire bytes, not text: chars/4 is meaningless on base64, and
			// the real cost is the model's tile math. Reported as 0 estimated tokens
			// on purpose — it surfaces in the reported-vs-estimated gap instead of
			// being silently wrong. See ContextBreakdown.imageBytes.
			const tokens = key === 'history:images' ? 0 : estTokens(chars);
			const items = this.#items.get(key);
			out.push({
				key,
				chars,
				tokens,
				...(items && {
					items: [...items]
						.map(([label, c]) => ({ label, chars: c }))
						.sort((a, b) => b.chars - a.chars),
				}),
			});
		}
		return out.sort((a, b) => b.chars - a.chars);
	}
}
