/**
 * Streaming compaction relay. Drives the summarization call for a prepared
 * `CompactionPlan` and streams the summary text to the client as it's produced,
 * persisting the anchor message on clean completion.
 *
 * Simpler than the chat relay: one upstream request, no tool loop, no
 * tee/recorder split (a single consumer both forwards text and accumulates it).
 * The key safety rule is **persist only on clean completion** — a summary cut
 * short by an upstream error or abort is discarded rather than written, because
 * a truncated anchor would silently drop real history from every later request.
 */

import { chatCompletionStream } from '../endpoints/client';
import { persistCompactionSummary, type CompactionPlan } from '../chat/compaction';
import { parseSSEStream } from './sse-parser';
import { createNormalizer } from './normalizers';
import { errorMessage, isAbortError, sseWriter } from './sse-transport';

export interface StreamCompactionArgs {
	conversationId: string;
	plan: CompactionPlan;
	/** Aborts the upstream call (e.g. client Stop); a partial summary is discarded. */
	abortSignal?: AbortSignal;
}

/**
 * Build the SSE body for a streaming compaction. Emits `compaction_start`,
 * then `compaction_text` deltas, then `compaction_done` (with the persisted
 * summary message) on success — or `error` on failure. Caller wraps this in
 * `sseResponse`.
 */
export function streamCompaction(args: StreamCompactionArgs): ReadableStream<Uint8Array> {
	const { conversationId, plan, abortSignal } = args;
	return new ReadableStream({
		async start(controller) {
			const { write, close } = sseWriter(controller);
			try {
				write({ type: 'compaction_start' });

				let upstream;
				try {
					upstream = await chatCompletionStream(
						plan.endpoint,
						{
							model: plan.upstreamId,
							messages: plan.messages,
							temperature: plan.temperature,
							max_tokens: plan.maxTokens,
							stream_options: { include_usage: true },
						},
						abortSignal,
					);
				} catch (e) {
					write({ type: 'error', message: errorMessage(e) });
					return;
				}
				if (!upstream.body) {
					write({ type: 'error', message: `Upstream "${plan.endpoint.id}" returned no body` });
					return;
				}

				const norm = createNormalizer(plan.providerQuirk);
				let textBuf = '';
				let aborted = false;
				const take = (chunk: string) => {
					if (!chunk) return;
					textBuf += chunk;
					write({ type: 'compaction_text', chunk });
				};

				try {
					for await (const record of parseSSEStream(upstream.body)) {
						const result = norm.process(record);
						// Only the summary text matters; reasoning deltas (if the
						// summarizer is a thinking model) are dropped.
						for (const d of result.deltas) if (d.type === 'text') take(d.text);
						if (result.done) break;
					}
					for (const d of norm.flush().deltas) if (d.type === 'text') take(d.text);
				} catch (e) {
					if (isAbortError(e) || abortSignal?.aborted) aborted = true;
					else {
						write({ type: 'error', message: `Upstream stream failed: ${errorMessage(e)}` });
						return;
					}
				}

				const summaryText = textBuf.trim();
				// Never persist a partial/empty anchor — it would drop real history
				// from later requests. Cancelled (user/browser aborted) and empty
				// (model completed but produced nothing) are distinct outcomes with
				// distinct messages, so an auto-path user who never asked for a
				// compaction doesn't see "cancelled".
				if (aborted) {
					write({ type: 'error', message: 'Compaction was cancelled.' });
					return;
				}
				if (!summaryText) {
					write({
						type: 'error',
						message: 'The model returned an empty summary; nothing was compacted.',
					});
					return;
				}

				const summaryMessage = await persistCompactionSummary(conversationId, plan, summaryText);
				write({ type: 'compaction_done', summaryMessage });
			} catch (e) {
				write({ type: 'error', message: errorMessage(e) });
			} finally {
				close();
			}
		},
	});
}
