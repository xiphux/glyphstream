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
	/**
	 * Authoritative generation time in ms, reported by the upstream when it
	 * exposes one (llama.cpp's `timings.predicted_ms`). Source-measured, so
	 * the relay prefers it over its own wall-clock first→last-token timing,
	 * which includes network transit. Absent for spec-pure backends.
	 */
	upstreamGenMs?: number;
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
	/** Required by the spec; some OpenAI-compatible layers omit it. */
	index?: number;
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
	/**
	 * llama.cpp server extension on the final usage chunk. Not OpenAI-spec,
	 * but purely additive and self-detecting (present or absent), so we read
	 * it opportunistically rather than gating it behind a provider_quirk.
	 * `predicted_ms` is the model's decode-only generation time.
	 */
	timings?: {
		predicted_ms?: number;
		predicted_per_second?: number;
	};
}

/**
 * Translate OpenAI's streamed `delta.tool_calls[]` into our normalized
 * tool-call deltas. The first chunk for a call brings `id` +
 * `function.name`; we emit a `tool_call_start` once. Later chunks for the
 * same call carry more `function.arguments`; we emit one
 * `tool_call_args_delta` per chunk and the recorder concatenates them.
 *
 * The emitted `index` is a slot this tracker assigns, not the upstream's
 * `index`, so that two upstream shapes that would otherwise collide stay
 * separate calls:
 *   - a NEW `id` on an `index` already in use starts a new call (a repeated
 *     id is just the provider re-sending it, and continues the call);
 *   - a chunk with no numeric `index` (some OpenAI-compatible layers omit
 *     it) is keyed by its `id` when it has one, and otherwise continues the
 *     most recently started call.
 * For a spec-shaped stream the slots equal the upstream indexes.
 *
 * Resilient defaults: an args-before-start chunk is dropped rather than
 * throwing, and an empty arguments delta is dropped to avoid spamming the
 * stream with empty events.
 */
class ToolCallTracker {
	/** Upstream key (numeric index, or `id:<id>` when the index is missing) → call. */
	private byKey = new Map<string, { slot: number; id: string }>();
	private nextSlot = 0;
	private last: { slot: number; id: string } | null = null;

	parse(calls: OpenAIToolCallDelta[] | undefined): NormalizedDelta[] {
		if (!calls || calls.length === 0) return [];
		const out: NormalizedDelta[] = [];
		for (const tc of calls) {
			const id = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : null;
			const key =
				typeof tc.index === 'number' ? `index:${tc.index}` : id !== null ? `id:${id}` : null;
			let call = key !== null ? this.byKey.get(key) : this.last;

			if (id !== null && call?.id !== id) {
				call = { slot: this.nextSlot++, id };
				if (key !== null) this.byKey.set(key, call);
				out.push({
					type: 'tool_call_start',
					toolCallId: id,
					toolName: tc.function?.name ?? '',
					index: call.slot,
				});
			}
			if (call) this.last = call;

			const argsDelta = tc.function?.arguments;
			if (call && typeof argsDelta === 'string' && argsDelta.length > 0) {
				out.push({
					type: 'tool_call_args_delta',
					toolCallId: call.id,
					index: call.slot,
					argumentsDelta: argsDelta,
				});
			}
		}
		return out;
	}
}

/**
 * Thrown when the upstream reports a failure inside an already-200 stream.
 * The relay treats it like any other mid-stream failure: it keeps what
 * arrived and records the error (relay.ts recorder).
 */
export class UpstreamStreamError extends Error {
	override name = 'UpstreamStreamError';
}

function parseChunk(record: SSERecord): OpenAIChunk | null {
	if (record.data === '[DONE]') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(record.data);
	} catch {
		return null;
	}
	// OpenAI, vLLM, OpenRouter and the bridge send `data: {"error": …}` when
	// generation fails after the response headers are out. It has no
	// `choices`, so read as a chunk it would yield nothing and the turn would
	// end as a silently empty reply.
	const error = (parsed as { error?: unknown } | null)?.error;
	if (error !== undefined && error !== null) {
		throw new UpstreamStreamError(describeStreamError(error));
	}
	return parsed as OpenAIChunk;
}

function describeStreamError(error: unknown): string {
	if (typeof error === 'string') return error;
	const message = (error as { message?: unknown }).message;
	if (typeof message === 'string' && message) return message;
	return JSON.stringify(error).slice(0, 500);
}

function commonExtras(
	chunk: OpenAIChunk,
): Pick<NormalizedResult, 'finishReason' | 'usage' | 'upstreamGenMs'> {
	const out: Pick<NormalizedResult, 'finishReason' | 'usage' | 'upstreamGenMs'> = {};
	const fin = chunk.choices?.[0]?.finish_reason;
	if (fin) out.finishReason = fin;
	if (chunk.usage) {
		out.usage = {
			promptTokens: chunk.usage.prompt_tokens,
			completionTokens: chunk.usage.completion_tokens,
		};
	}
	const predictedMs = chunk.timings?.predicted_ms;
	if (typeof predictedMs === 'number' && predictedMs > 0) {
		out.upstreamGenMs = predictedMs;
	}
	return out;
}

// --- passthrough: just delta.content as text + tool_calls ---------------

class PassthroughNormalizer implements StreamNormalizer {
	private toolCalls = new ToolCallTracker();
	process(record: SSERecord): NormalizedResult {
		if (record.data === '[DONE]') return { deltas: [], done: true };
		const chunk = parseChunk(record);
		if (!chunk) return EMPTY;
		const delta = chunk.choices?.[0]?.delta;
		const deltas: NormalizedDelta[] = [];
		if (delta?.content) deltas.push({ type: 'text', text: delta.content });
		deltas.push(...this.toolCalls.parse(delta?.tool_calls));
		return { deltas, ...commonExtras(chunk) };
	}
	flush(): NormalizedResult {
		return EMPTY;
	}
}

// --- openai-o-series: delta.reasoning_content + delta.content + tool_calls

class OSeriesNormalizer implements StreamNormalizer {
	private toolCalls = new ToolCallTracker();
	process(record: SSERecord): NormalizedResult {
		if (record.data === '[DONE]') return { deltas: [], done: true };
		const chunk = parseChunk(record);
		if (!chunk) return EMPTY;
		const delta = chunk.choices?.[0]?.delta;
		const deltas: NormalizedDelta[] = [];
		if (delta?.reasoning_content) deltas.push({ type: 'reasoning', text: delta.reasoning_content });
		if (delta?.content) deltas.push({ type: 'text', text: delta.content });
		deltas.push(...this.toolCalls.parse(delta?.tool_calls));
		return { deltas, ...commonExtras(chunk) };
	}
	flush(): NormalizedResult {
		return EMPTY;
	}
}

// --- openrouter: delta.reasoning + delta.content + tool_calls -----------

class OpenRouterNormalizer implements StreamNormalizer {
	private toolCalls = new ToolCallTracker();
	process(record: SSERecord): NormalizedResult {
		if (record.data === '[DONE]') return { deltas: [], done: true };
		const chunk = parseChunk(record);
		if (!chunk) return EMPTY;
		const delta = chunk.choices?.[0]?.delta;
		const deltas: NormalizedDelta[] = [];
		if (delta?.reasoning) deltas.push({ type: 'reasoning', text: delta.reasoning });
		if (delta?.content) deltas.push({ type: 'text', text: delta.content });
		deltas.push(...this.toolCalls.parse(delta?.tool_calls));
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
