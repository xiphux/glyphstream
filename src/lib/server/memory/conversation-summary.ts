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
import { UpstreamError, isPermanentRequestError } from '../endpoints/client';
import { isWithinWindow } from './dream-window';
import { summarizeConversation, buildTranscript } from './conversation-summarizer';
import { buildOverview } from './conversation-overview';
import {
	listConversationsNeedingSummary,
	listConversationSummariesForOverview,
	setConversationSummary,
} from '../db/queries/conversations';
import {
	getConversationOverview,
	listUsersNeedingOverview,
	setConversationOverview,
} from '../db/queries/users';
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
const MAX_USERS_PER_SWEEP = 20;

let timer: NodeJS.Timeout | null = null;
let running = false;
let generation = 0;

/**
 * One sweep, two phases: (1) summarize each due conversation, then (2) rebuild the
 * orientation overview for each user whose summaries changed. Phase 2 runs after
 * phase 1 so a conversation summarized this sweep is already reflected in the
 * overview. No-op outside the window / when no memory model is configured / when a
 * sweep is already running. `now` injected for deterministic tests. Directly
 * callable.
 */
export async function runSummarySweep(
	now: number = Date.now(),
): Promise<{ summarized: number; overviewsUpdated: number }> {
	if (running) return { summarized: 0, overviewsUpdated: 0 };
	running = true;
	try {
		const model = getMemoryModel();
		if (!model) return { summarized: 0, overviewsUpdated: 0 };
		if (!isWithinWindow(new Date(now), model.activeHours, model.timezone)) {
			return { summarized: 0, overviewsUpdated: 0 };
		}

		const contextWindow = await resolveContextWindow(model);

		// Phase 1 — per-conversation summaries.
		const due = listConversationsNeedingSummary(now, SETTLE_MS, MAX_CONVERSATIONS_PER_SWEEP);
		let summarized = 0;
		for (const { id } of due) {
			try {
				if (await summarizeOne(model, id, contextWindow, now)) summarized++;
			} catch (e) {
				if (e instanceof UpstreamError && !isPermanentRequestError(e)) {
					// A transient endpoint failure (5xx / network / timeout / 429) or a
					// systemic auth failure (401 / 403 / 407): the rest of this sweep would
					// fail the same way, so end it and retry next tick rather than burning
					// the whole backlog on doomed calls.
					console.warn('[conversation-summary] endpoint error; ending sweep:', e);
					return { summarized, overviewsUpdated: 0 };
				}
				// A permanent per-request rejection (e.g. 400 context-size overflow) or a
				// non-upstream error: skip THIS conversation and keep sweeping. A permanent
				// 4xx recurs every sweep, so bailing here would let one poison conversation
				// wedge the entire oldest-first backlog behind it. The watermark is left
				// unadvanced, so it retries once a bigger margin / config fix lets it fit.
				console.warn(`[conversation-summary] conversation ${id} failed, skipping:`, e);
			}
		}

		// Phase 2 — rebuild overviews for users whose summaries changed.
		const users = listUsersNeedingOverview().slice(0, MAX_USERS_PER_SWEEP);
		let overviewsUpdated = 0;
		for (const userId of users) {
			try {
				if (await rebuildOverview(model, userId, contextWindow, now)) overviewsUpdated++;
			} catch (e) {
				if (e instanceof UpstreamError && !isPermanentRequestError(e)) {
					console.warn('[conversation-summary] endpoint error during overviews; ending:', e);
					break;
				}
				// Permanent per-request rejection or a non-upstream error: skip this user's
				// overview and keep going, so one user can't stall everyone behind them.
				console.warn(`[conversation-summary] overview for user ${userId} failed, skipping:`, e);
			}
		}

		if (summarized > 0 || overviewsUpdated > 0) {
			console.log(
				`[conversation-summary] sweep: summarized=${summarized} overviews=${overviewsUpdated}`,
			);
		}
		return { summarized, overviewsUpdated };
	} finally {
		running = false;
	}
}

/**
 * Rebuild one user's overview from all their conversation summaries and stamp the
 * watermark. Returns true if a map was written. Only reached for users the watermark
 * query found with ≥1 summary; the "all summarized conversations deleted" case is
 * handled at delete time (`reconcileOverviewAfterConversationDelete`), not here.
 *
 * A model that yields nothing leaves BOTH the stored map and the watermark alone —
 * same contract as `summarizeOne`, and load-bearing here in a way it isn't there.
 * The rebuild is destructive by design (rebuild-from-all, so deletions propagate),
 * so writing an empty completion would erase a good map; and because the write also
 * stamps the watermark, `listUsersNeedingOverview` would then consider the user
 * settled and never rebuild it. One bad response would cost the map until some
 * unrelated conversation happened to be summarized.
 */
async function rebuildOverview(
	model: ResolvedMemoryModel,
	userId: string,
	contextWindow: number | null,
	now: number,
): Promise<boolean> {
	const summaries = listConversationSummariesForOverview(userId);
	const overview = await buildOverview(
		model,
		getConversationOverview(userId),
		summaries,
		contextWindow,
	);
	if (!overview) {
		console.warn(
			`[conversation-summary] overview for user ${userId} came back empty; keeping the stored map, retrying next sweep`,
		);
		return false;
	}
	setConversationOverview(userId, overview, now);
	return true;
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
	const messages = walkActiveBranch(conversationId, { columns: 'serialization' });
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
				if (generation === myGen) {
					timer = setTimeout(tick, SWEEP_INTERVAL_MS);
					timer?.unref();
				}
			});
	}
	timer = setTimeout(tick, INITIAL_DELAY_MS);
	timer?.unref();
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
