/**
 * Per-provider stream normalizers. Each takes raw SSE records (from the
 * upstream's `/v1/chat/completions` SSE) and emits internal "delta" parts
 * — text or reasoning chunks — that GlyphStream's UI and persister both
 * consume identically.
 *
 * Stateful because some quirks (notably DeepSeek-R1's `<think>...</think>`
 * inline reasoning) need to buffer mid-tag content across SSE chunks.
 */

import type { ProviderQuirk } from '../endpoints/config';
import type { SSERecord } from './sse-parser';

export type NormalizedDelta =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	/** First time we've seen a given tool_call (keyed by upstream's
	 *  `index`). The recorder uses this to seed a tool_call part; the
	 *  client uses it to insert a "calling X" entry in the in-flight UI. */
	| { type: 'tool_call_start'; toolCallId: string; toolName: string; index: number }
	/** Subsequent chunk carrying more of the argument JSON for an
	 *  already-started tool_call. OpenAI streams arguments incrementally;
	 *  callers accumulate the deltas keyed by `toolCallId`. */
	| {
			type: 'tool_call_args_delta';
			toolCallId: string;
			index: number;
			argumentsDelta: string;
	  };

export interface NormalizedResult {
	deltas: NormalizedDelta[];
	finishReason?: string | null;
	usage?: { promptTokens?: number; completionTokens?: number };
	done?: boolean;
}

export interface StreamNormalizer {
	/** Process one upstream SSE record. */
	process(record: SSERecord): NormalizedResult;
	/** Drain any buffered state at end-of-stream. */
	flush(): NormalizedResult;
}

const EMPTY: NormalizedResult = { deltas: [] };

/** Per-index tool-call entry on a streamed `delta`. OpenAI sends `id` +
 *  `function.name` once (on the first chunk for that index) and then
 *  streams `function.arguments` in subsequent chunks keyed by `index`. */
interface OpenAIToolCallDelta {
	index: number;
	id?: string;
	type?: 'function';
	function?: { name?: string; arguments?: string };
}

/** Standard OpenAI delta chunk. Common fields used by all backends. */
interface OpenAIChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: OpenAIToolCallDelta[];
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

/**
 * Translate OpenAI's streamed `delta.tool_calls[]` into our normalized
 * tool-call deltas. The first chunk for a given `index` brings `id` +
 * `function.name`; we emit a `tool_call_start` once and remember the id
 * by index. Subsequent chunks for the same index carry more
 * `function.arguments`; we emit one `tool_call_args_delta` per chunk and
 * the recorder concatenates them.
 *
 * `seenById` is the per-normalizer-instance state map (passed by ref so
 * callers can hold it on their class). Resilient defaults: an
 * args-before-start chunk (spec-violating upstream) is dropped rather
 * than throwing. An empty/whitespace arguments delta is also dropped to
 * avoid spamming the stream with empty events.
 */
function parseToolCallsDelta(
	calls: OpenAIToolCallDelta[] | undefined,
	seenById: Map<number, string>,
): NormalizedDelta[] {
	if (!calls || calls.length === 0) return [];
	const out: NormalizedDelta[] = [];
	for (const tc of calls) {
		if (typeof tc.index !== 'number') continue;

		// First chunk for this index — record id + emit start.
		if (typeof tc.id === 'string' && tc.id.length > 0 && !seenById.has(tc.index)) {
			seenById.set(tc.index, tc.id);
			out.push({
				type: 'tool_call_start',
				toolCallId: tc.id,
				toolName: tc.function?.name ?? '',
				index: tc.index,
			});
		}

		// Args delta — must come AFTER we've recorded the id.
		const argsDelta = tc.function?.arguments;
		if (typeof argsDelta === 'string' && argsDelta.length > 0) {
			const id = seenById.get(tc.index);
			if (id) {
				out.push({
					type: 'tool_call_args_delta',
					toolCallId: id,
					index: tc.index,
					argumentsDelta: argsDelta,
				});
			}
		}
	}
	return out;
}

function parseChunk(record: SSERecord): OpenAIChunk | null {
	if (record.data === '[DONE]') return null;
	try {
		return JSON.parse(record.data) as OpenAIChunk;
	} catch {
		return null;
	}
}

function commonExtras(chunk: OpenAIChunk): Pick<NormalizedResult, 'finishReason' | 'usage'> {
	const out: Pick<NormalizedResult, 'finishReason' | 'usage'> = {};
	const fin = chunk.choices?.[0]?.finish_reason;
	if (fin) out.finishReason = fin;
	if (chunk.usage) {
		out.usage = {
			promptTokens: chunk.usage.prompt_tokens,
			completionTokens: chunk.usage.completion_tokens,
		};
	}
	return out;
}

// --- passthrough: just delta.content as text + tool_calls ---------------

class PassthroughNormalizer implements StreamNormalizer {
	private toolCallIdByIndex = new Map<number, string>();
	process(record: SSERecord): NormalizedResult {
		if (record.data === '[DONE]') return { deltas: [], done: true };
		const chunk = parseChunk(record);
		if (!chunk) return EMPTY;
		const delta = chunk.choices?.[0]?.delta;
		const deltas: NormalizedDelta[] = [];
		if (delta?.content) deltas.push({ type: 'text', text: delta.content });
		deltas.push(...parseToolCallsDelta(delta?.tool_calls, this.toolCallIdByIndex));
		return { deltas, ...commonExtras(chunk) };
	}
	flush(): NormalizedResult {
		return EMPTY;
	}
}

// --- openai-o-series: delta.reasoning_content + delta.content + tool_calls

class OSeriesNormalizer implements StreamNormalizer {
	private toolCallIdByIndex = new Map<number, string>();
	process(record: SSERecord): NormalizedResult {
		if (record.data === '[DONE]') return { deltas: [], done: true };
		const chunk = parseChunk(record);
		if (!chunk) return EMPTY;
		const delta = chunk.choices?.[0]?.delta;
		const deltas: NormalizedDelta[] = [];
		if (delta?.reasoning_content) deltas.push({ type: 'reasoning', text: delta.reasoning_content });
		if (delta?.content) deltas.push({ type: 'text', text: delta.content });
		deltas.push(...parseToolCallsDelta(delta?.tool_calls, this.toolCallIdByIndex));
		return { deltas, ...commonExtras(chunk) };
	}
	flush(): NormalizedResult {
		return EMPTY;
	}
}

// --- openrouter: delta.reasoning + delta.content + tool_calls -----------

class OpenRouterNormalizer implements StreamNormalizer {
	private toolCallIdByIndex = new Map<number, string>();
	process(record: SSERecord): NormalizedResult {
		if (record.data === '[DONE]') return { deltas: [], done: true };
		const chunk = parseChunk(record);
		if (!chunk) return EMPTY;
		const delta = chunk.choices?.[0]?.delta;
		const deltas: NormalizedDelta[] = [];
		if (delta?.reasoning) deltas.push({ type: 'reasoning', text: delta.reasoning });
		if (delta?.content) deltas.push({ type: 'text', text: delta.content });
		deltas.push(...parseToolCallsDelta(delta?.tool_calls, this.toolCallIdByIndex));
		return { deltas, ...commonExtras(chunk) };
	}
	flush(): NormalizedResult {
		return EMPTY;
	}
}

// --- deepseek-r1: <think>...</think> inline in delta.content ------------
//
// State machine handles three things across SSE chunks:
//  1. The content stream may begin partway through a `<think>` tag.
//  2. Tags can be split across chunks (e.g. `<thi` then `nk>`).
//  3. Closing tag `</think>` ditto.
//
// Buffer holds suspicious leading chars whenever they could be the start of
// a tag; release them only once we know they are NOT a tag start.

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

class DeepseekR1Normalizer implements StreamNormalizer {
	private mode: 'text' | 'reasoning' = 'text';
	private buffer = ''; // possibly-mid-tag chars not yet released

	process(record: SSERecord): NormalizedResult {
		if (record.data === '[DONE]') return { deltas: [], done: true };
		const chunk = parseChunk(record);
		if (!chunk) return EMPTY;
		const incoming = chunk.choices?.[0]?.delta?.content ?? '';
		const deltas = incoming.length > 0 ? this.consume(incoming, false) : [];
		return { deltas, ...commonExtras(chunk) };
	}

	flush(): NormalizedResult {
		const deltas = this.consume('', true);
		return { deltas };
	}

	private consume(incoming: string, isFinal: boolean): NormalizedDelta[] {
		this.buffer += incoming;
		const out: NormalizedDelta[] = [];

		// Walk until we either run out of decisions to make OR we're left
		// with a buffer that COULD be a partial tag and we should hold it.
		while (this.buffer.length > 0) {
			const target = this.mode === 'text' ? THINK_OPEN : THINK_CLOSE;
			const idx = this.buffer.indexOf(target);

			if (idx !== -1) {
				// Found the next tag — emit the prefix in current mode, then flip.
				if (idx > 0) {
					out.push({
						type: this.mode === 'text' ? 'text' : 'reasoning',
						text: this.buffer.slice(0, idx),
					});
				}
				this.buffer = this.buffer.slice(idx + target.length);
				this.mode = this.mode === 'text' ? 'reasoning' : 'text';
				continue;
			}

			// No full tag in buffer. Could the tail be a partial tag?
			const partialLen = longestPartialPrefix(this.buffer, target);
			if (partialLen > 0 && !isFinal) {
				// Emit everything except the suspect tail; hold the tail.
				const safe = this.buffer.slice(0, this.buffer.length - partialLen);
				if (safe.length > 0) {
					out.push({ type: this.mode === 'text' ? 'text' : 'reasoning', text: safe });
				}
				this.buffer = this.buffer.slice(this.buffer.length - partialLen);
				break;
			}

			// All clear (or end of stream): emit the whole buffer.
			out.push({ type: this.mode === 'text' ? 'text' : 'reasoning', text: this.buffer });
			this.buffer = '';
			break;
		}
		return out;
	}
}

/** Length of the longest suffix of `buf` that is a prefix of `target`. */
function longestPartialPrefix(buf: string, target: string): number {
	const max = Math.min(buf.length, target.length - 1);
	for (let n = max; n > 0; n--) {
		if (target.startsWith(buf.slice(buf.length - n))) return n;
	}
	return 0;
}

// --- factory ------------------------------------------------------------

export function createNormalizer(quirk: ProviderQuirk): StreamNormalizer {
	switch (quirk) {
		case 'deepseek-r1':
			return new DeepseekR1Normalizer();
		case 'openai-o-series':
			return new OSeriesNormalizer();
		case 'openrouter':
			return new OpenRouterNormalizer();
		case 'passthrough':
		default:
			return new PassthroughNormalizer();
	}
}
