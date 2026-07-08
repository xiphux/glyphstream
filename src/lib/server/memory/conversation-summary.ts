/**
 * The per-conversation summary worker. During the same configured quiet-hours
 * window as the dreaming pass, it writes a short denoised gist for each settled,
 * changed conversation and (via a DB trigger) indexes it into `search_index` so
 * `search_conversations` surfaces threads by meaning, not just literal token
 * overlap.
 *
 * Shares the memory model + window + endpoint slot with the dreaming worker but
 * stays a SEPARATE worker (different unit — per-conversation vs per-user — and
 * watermark). The shared per-endpoint slot (taken per model call inside
 * `summarizeConversation`) is what keeps the two from over-running `max_concurrent`;
 * a distinct `INITIAL_DELAY_MS` phase-offsets their sweeps so they don't reliably
 * start in the same tick. Worker skeleton mirrors `dreaming.ts` (recursive tick,
 * `running` guard, generation-token stop, no-op when no memory model configured).
 */

import { getMemoryModel, type ResolvedMemoryModel } from '../tasks/memory-model';
import { UpstreamError } from '../endpoints/client';
import { isWithinWindow } from './dream-window';
import { summarizeConversation, buildTranscript } from './conversation-summarizer';
import {
	listConversationsNeedingSummary,
	setConversationSummary,
} from '../db/queries/conversations';
import { walkActiveBranch } from '../db/queries/messages';
import { listAllModels } from '../endpoints/list-models';
import { formatModelId } from '../endpoints/model-id';

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
// Phase-offset from dreaming's 30s so their sweeps don't reliably start together
// and pile onto the shared endpoint slot in the same tick.
const INITIAL_DELAY_MS = 90_000;
// A conversation must be inactive this long before we summarize it — so we never
// summarize one mid-exchange, and a burst of edits coalesces into one pass.
const SETTLE_MS = 60 * 60 * 1000;
// Bound per sweep so a large backlog spreads across ticks.
const MAX_CONVERSATIONS_PER_SWEEP = 20;

let timer: NodeJS.Timeout | null = null;
let running = false;
let generation = 0;

/**
 * One summary pass. No-op outside the window / when no memory model is configured
 * / when a sweep is already running. `now` injected for deterministic tests.
 * Directly callable. Returns how many conversations were summarized.
 */
export async function runSummarySweep(now: number = Date.now()): Promise<{ summarized: number }> {
	if (running) return { summarized: 0 };
	running = true;
	try {
		const model = getMemoryModel();
		if (!model) return { summarized: 0 };
		if (!isWithinWindow(new Date(now), model.activeHours, model.timezone)) {
			return { summarized: 0 };
		}

		const contextWindow = await resolveContextWindow(model);
		const due = listConversationsNeedingSummary(now, SETTLE_MS, MAX_CONVERSATIONS_PER_SWEEP);
		let summarized = 0;
		for (const { id } of due) {
			try {
				if (await summarizeOne(model, id, contextWindow, now)) summarized++;
			} catch (e) {
				if (e instanceof UpstreamError) {
					// Shared endpoint down/timeout: end the sweep rather than hammer it
					// once per remaining conversation. Watermarks unadvanced → retry next window.
					console.warn('[conversation-summary] endpoint error; ending sweep:', e);
					break;
				}
				// Per-conversation failure: skip it (watermark unadvanced → retries) so one
				// bad conversation can't starve those ordered after it.
				console.warn(`[conversation-summary] conversation ${id} failed, skipping:`, e);
			}
		}
		if (summarized > 0) console.log(`[conversation-summary] sweep: summarized=${summarized}`);
		return { summarized };
	} finally {
		running = false;
	}
}

/**
 * Summarize one conversation and stamp its watermark. Returns true if a summary
 * was written. A conversation with no summarizable text (image-only) stamps a
 * null summary so it isn't reconsidered every sweep. A model that yields nothing
 * leaves the watermark unadvanced (retry next sweep) rather than storing an empty
 * gist.
 */
async function summarizeOne(
	model: ResolvedMemoryModel,
	conversationId: string,
	contextWindow: number | null,
	now: number,
): Promise<boolean> {
	const messages = walkActiveBranch(conversationId);
	// Nothing worth indexing (e.g. an image-only exchange) — stamp and move on.
	if (buildTranscript(messages).length === 0) {
		setConversationSummary(conversationId, null, now);
		return false;
	}
	const summary = await summarizeConversation(model, messages, contextWindow);
	if (!summary) return false; // model returned nothing → don't stamp; retry next sweep
	setConversationSummary(conversationId, summary, now);
	return true;
}

/** The memory model's context window (tokens), or null when unresolvable — the
 *  summarizer falls back to a conservative default. Same resolution compaction
 *  uses: match the composed model id against the models list. */
async function resolveContextWindow(model: ResolvedMemoryModel): Promise<number | null> {
	const id = formatModelId(model.endpoint.id, model.upstreamId);
	return (await listAllModels()).find((m) => m.id === id)?.contextWindow ?? null;
}

/**
 * Mount the periodic summary worker. Idempotent; no-op when no `[memory_model]`
 * is configured. Recurring; the generation token prevents a stop during an
 * in-flight sweep from re-arming.
 */
export function startConversationSummaryWorker(): void {
	if (timer) return;
	if (!getMemoryModel()) return;
	const myGen = ++generation;
	function tick() {
		runSummarySweep()
			.catch((e) => console.error('[conversation-summary] sweep failed:', e))
			.finally(() => {
				if (generation === myGen) timer = setTimeout(tick, SWEEP_INTERVAL_MS);
			});
	}
	timer = setTimeout(tick, INITIAL_DELAY_MS);
	console.log(`[conversation-summary] started; sweep every ${SWEEP_INTERVAL_MS / 60000}min`);
}

/** Tear down the timer — for tests / clean shutdown. Bumps the generation so an
 *  in-flight sweep won't re-arm. */
export function stopConversationSummaryWorker(): void {
	generation++;
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}
