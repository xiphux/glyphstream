/**
 * The phase-4 memory-consolidation ("dreaming") worker. During a configured
 * quiet-hours window, it asks the memory model to tidy each changed user's saved
 * memories (merge duplicates, fold supersessions, distill ephemera, prune as a
 * last resort) and applies the result. It also reaps soft-deleted tombstones past
 * the retention window every tick.
 *
 * Safety layers: a capable dedicated model, durability-first prompting +
 * validation (`consolidation.ts`), and soft-delete reversibility — plus the apply
 * step orders each merge update-survivor-FIRST then soft-delete-sources, so a
 * crash mid-merge leaves benign duplicates (re-consolidated next pass), never
 * information loss.
 *
 * GPU-contention safety: gated by the tz-aware window (the real safeguard for a
 * busy endpoint), and every model call takes a slot on the same per-endpoint FIFO
 * gate live chats use (`acquireEndpointSlot`) — so a dream never preempts or cuts
 * ahead of a chat. It is a fair peer, not a low-priority lane: if a dream call is
 * already in flight when a chat arrives, the chat waits for it (bounded by the
 * endpoint's `max_concurrent`). Worker skeleton mirrors the other background
 * workers (recursive tick, `running` guard, generation-token stop, no-op when no
 * model is configured).
 */

import { getMemoryModel, type ResolvedMemoryModel } from '../tasks/memory-model';
import { UpstreamError } from '../endpoints/client';
import { acquireEndpointSlot } from '../endpoints/concurrency';
import { isWithinWindow } from './dream-window';
import {
	proposeConsolidation,
	type ConsolidationOp,
	type MemoryForConsolidation,
} from './consolidation';
import {
	listMemoriesForDreaming,
	listUsersNeedingDreaming,
	purgeSoftDeletedMemories,
	renameMemoryTopic,
	setUserDreamedAt,
	softDeleteMemory,
	updateMemoryGuarded,
	type MemoryForDreaming,
} from '../db/queries/memories';

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 30_000;
// How long a soft-deleted memory stays recoverable before the purge reaps it.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Bound per sweep so a big multi-user instance spreads consolidation across ticks.
const MAX_USERS_PER_SWEEP = 20;

let timer: NodeJS.Timeout | null = null;
let running = false;
let generation = 0;

/**
 * One dreaming pass. Purges expired tombstones every tick; then, if within the
 * window, consolidates each changed user's memories (bounded per sweep). `now` is
 * injected for deterministic window/purge tests. No-op when no memory model is
 * configured or a sweep is already running. Directly callable (tests).
 */
export async function runDreamSweep(
	now: number = Date.now(),
): Promise<{ purged: number; usersProcessed: number; opsApplied: number }> {
	if (running) return { purged: 0, usersProcessed: 0, opsApplied: 0 };
	running = true;
	try {
		const model = getMemoryModel();
		if (!model) return { purged: 0, usersProcessed: 0, opsApplied: 0 };

		const purged = purgeSoftDeletedMemories(now - RETENTION_MS);

		if (!isWithinWindow(new Date(now), model.activeHours, model.timezone)) {
			return { purged, usersProcessed: 0, opsApplied: 0 };
		}

		const users = listUsersNeedingDreaming().slice(0, MAX_USERS_PER_SWEEP);
		let usersProcessed = 0;
		let opsApplied = 0;
		for (const userId of users) {
			try {
				opsApplied += await dreamUser(model, userId);
				usersProcessed++;
			} catch (e) {
				if (e instanceof UpstreamError) {
					// Endpoint-level failure (shared — down / timeout): end the sweep
					// rather than hammer it once per remaining user. Watermark unadvanced,
					// so everyone retries next window.
					console.warn(`[dreaming] endpoint error; ending sweep, retry next window:`, e);
					break;
				}
				// A per-user failure (rare — the parse is defensive and apply is simple):
				// skip just this user so one deterministic error can't starve those
				// ordered after it; their watermark is unadvanced, so they retry.
				console.warn(`[dreaming] user ${userId} failed, skipping:`, e);
			}
		}
		if (opsApplied > 0 || purged > 0) {
			console.log(`[dreaming] sweep: users=${usersProcessed} ops=${opsApplied} purged=${purged}`);
		}
		return { purged, usersProcessed, opsApplied };
	} finally {
		running = false;
	}
}

/** Consolidate one user's memories and advance their watermark. Returns ops applied. */
async function dreamUser(model: ResolvedMemoryModel, userId: string): Promise<number> {
	// Capture the watermark BEFORE the snapshot: anything the user saves/edits
	// during the (queued, slow) pass has an updated_at ≥ this, so it re-flags the
	// user next window rather than being skipped. (The pass's own writes also
	// re-flag once, but the re-run finds a settled store and does nothing.)
	const startedAt = Date.now();
	const rows = listMemoriesForDreaming(userId);
	// Nothing to consolidate against, but still stamp the watermark so a settled
	// store isn't re-examined every window.
	if (rows.length < 2) {
		setUserDreamedAt(userId, startedAt);
		return 0;
	}

	const input: MemoryForConsolidation[] = rows.map((m) => ({
		id: m.id,
		content: m.content,
		topic: m.topic,
	}));

	// Queue behind live chats on the shared endpoint; release even on error/abort.
	const slot = await acquireEndpointSlot(model.endpoint.id, model.endpoint.maxConcurrent);
	let ops: ConsolidationOp[];
	try {
		ops = await proposeConsolidation(model, input);
	} finally {
		slot.release();
	}

	const applied = applyConsolidation(userId, ops, rows);
	setUserDreamedAt(userId, startedAt);
	return applied;
}

/**
 * Apply validated ops to a user's store. Every write is guarded on the SNAPSHOT
 * content (`updateMemoryGuarded` / `softDeleteMemory` / `renameMemoryTopic` all
 * take `expectedContent`): if the user edited a target row during the in-flight
 * pass, that op no-ops and re-consolidates next pass rather than clobbering the
 * fresh edit. Each merge updates the survivor (highest recall score) FIRST, then
 * soft-deletes the other sources pointing `superseded_by` at it — so a crash
 * between the two leaves duplicates, not a gap. Returns the number of ops that
 * took effect. Exported for testing.
 */
export function applyConsolidation(
	userId: string,
	ops: ConsolidationOp[],
	rows: MemoryForDreaming[],
): number {
	const byId = new Map(rows.map((m) => [m.id, m]));
	let applied = 0;
	for (const op of ops) {
		switch (op.type) {
			case 'merge': {
				const survivor = pickSurvivor(op.ids, byId);
				const snap = survivor ? byId.get(survivor) : undefined;
				if (!survivor || !snap) break;
				if (updateMemoryGuarded(userId, survivor, snap.content, op.content, op.topic)) {
					for (const id of op.ids) {
						if (id === survivor) continue;
						const srcContent = byId.get(id)?.content;
						if (srcContent !== undefined) softDeleteMemory(userId, id, survivor, srcContent);
					}
					applied++;
				}
				break;
			}
			case 'reword': {
				const snap = byId.get(op.id);
				if (snap && updateMemoryGuarded(userId, op.id, snap.content, op.content, op.topic)) {
					applied++;
				}
				break;
			}
			case 'retopic': {
				const snap = byId.get(op.id);
				if (snap && renameMemoryTopic(userId, op.id, op.topic, snap.content)) applied++;
				break;
			}
			case 'prune': {
				const snap = byId.get(op.id);
				if (snap && softDeleteMemory(userId, op.id, null, snap.content)) applied++;
				break;
			}
		}
	}
	return applied;
}

/** The merge survivor: highest recall count, then most recently recalled, then
 *  oldest (stable — keeps the longest-lived row's id). */
function pickSurvivor(ids: string[], byId: Map<string, MemoryForDreaming>): string | null {
	const rows = ids.map((id) => byId.get(id)).filter((m): m is MemoryForDreaming => m !== undefined);
	if (rows.length === 0) return null;
	rows.sort(
		(a, b) =>
			b.recallCount - a.recallCount ||
			(b.lastRecalledAt ?? 0) - (a.lastRecalledAt ?? 0) ||
			a.createdAt - b.createdAt,
	);
	return rows[0].id;
}

/**
 * Mount the periodic dreaming worker. Idempotent; no-op when no `[memory_model]`
 * is configured. Recurring (dreaming is ongoing — it doesn't self-stop). The
 * generation token means a stop during an in-flight sweep won't re-arm.
 */
export function startDreamingWorker(): void {
	if (timer) return;
	if (!getMemoryModel()) return;
	const myGen = ++generation;
	function tick() {
		runDreamSweep()
			.catch((e) => console.error('[dreaming] sweep failed:', e))
			.finally(() => {
				if (generation === myGen) timer = setTimeout(tick, SWEEP_INTERVAL_MS);
			});
	}
	timer = setTimeout(tick, INITIAL_DELAY_MS);
	console.log(`[dreaming] started; sweep every ${SWEEP_INTERVAL_MS / 60000}min`);
}

/** Tear down the timer — for tests / clean shutdown. Bumps the generation so an
 *  in-flight sweep won't re-arm. */
export function stopDreamingWorker(): void {
	generation++;
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}
