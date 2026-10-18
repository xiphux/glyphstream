/**
 * Per-model usage + reception counters — the write side of
 * `/settings/model-stats`. See `modelStatsDaily` in the schema for why these
 * are counted as events rather than derived from `messages` / `media`.
 *
 * Every write is BEST-EFFORT: a stats failure is logged and swallowed, never
 * surfaced, so the chat or generation that triggered it can't fail over a
 * counter. Callers inside a transaction pass their `tx` so the counter lands
 * (or rolls back) with the event it describes.
 *
 * Attribution is the caller's job, and it isn't always the model that just
 * ran: a retry or an edit is a verdict on the reply being REPLACED, a
 * favourite or a trash on the media row's `source_model`, a switch on the model
 * being switched AWAY from.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type DB, type Tx } from '#lib/server/db/client.js';
import { media, modelStatsDaily, modelUserUsage } from '#lib/server/db/schema.js';
import { parseModelId } from '#lib/server/endpoints/model-id.js';
import { createLogger } from '#lib/server/log.js';

const log = createLogger('model-stats');

/**
 * The metric vocabulary. Stored as text, so adding one needs no migration —
 * but a name, once shipped, is history: renaming it orphans every row counted
 * under the old one.
 */
export type ModelMetric =
	// --- chat ---
	/** A completed chat turn, counted once per turn (not per tool-loop
	 *  iteration); `sum` is the turn's tokens out. */
	| 'turn'
	/** The reply was regenerated. Attributed to the REPLACED reply's model. */
	| 'retry'
	/** …and that replaced reply had been stopped mid-stream: the user stopped
	 *  it and asked again with the same prompt — a verdict on the model. */
	| 'retry_after_cancel'
	/** The user edited the prompt a reply answered. Attributed to that reply's
	 *  model; the prompt, not the model, is what was revised. */
	| 'edit'
	/** …and that reply had been stopped: a stop the user then blamed on their
	 *  own prompt (a typo, an early Enter) — neutral for the model. */
	| 'edit_after_cancel'
	/** Stopped by the user after some of the reply streamed. */
	| 'cancelled'
	/** The turn failed: a mid-stream error or an upstream refusal. */
	| 'error'
	/** The upstream stopped at its length limit (`finish_reason = 'length'`). */
	| 'truncated'
	/** A chat turn on a different CHAT model in a conversation that was on this
	 *  one. A chat → image switch is a change of medium, not an abandonment, and
	 *  isn't counted. */
	| 'switched_away'
	/** A reply on a branch the user deleted. */
	| 'branch_deleted'
	/** In a side-by-side comparison the user resolved by picking a reply. */
	| 'fanout_shown'
	/** The reply picked. A RELATIVE signal: the others weren't necessarily bad,
	 *  just not the best fit, so there is deliberately no "loss" — rejection is
	 *  what `branch_deleted` / `trashed` count. */
	| 'fanout_win'
	/** Tokens out across turns whose duration is known (`sum`), paired with
	 *  `speed_ms` for a tokens/sec figure free of turns missing either half. */
	| 'speed_tokens'
	/** Generation time in ms (`sum`) — for chat, of the turns `speed_tokens`
	 *  counts; for media, of every generation that reported one. */
	| 'speed_ms'
	// --- image / video ---
	/** An image or video produced; `count` is outputs, not requests. */
	| 'generated'
	/** A generation that failed or was abandoned after its retry budget. */
	| 'failed'
	/** The user moved the output to the trash, explicitly or by deleting the
	 *  branch it was on. */
	| 'trashed'
	/** Trashed as a side effect of deleting the whole conversation with "also
	 *  delete media" — the user cleaning up, not judging this output. */
	| 'swept'
	/** Brought back out of the trash. Nets against `trashed` / `swept`. */
	| 'restored'
	| 'favorited'
	| 'unfavorited'
	/** A GENERATED output used as the input to a new generation. */
	| 'remixed'
	/** A generated image chosen as a conversation's avatar. */
	| 'avatar_set'
	/** In a multi-model avatar comparison the user picked from, and picked —
	 *  relative, like `fanout_shown` / `fanout_win`. */
	| 'avatar_shown'
	| 'avatar_win'
	// --- other ---
	/** A conversation started from a custom-model preset, counted against the
	 *  preset's BASE model so a preset's usage sits with the model it costs. */
	| `preset_chat:${string}`
	/** A call made for a background task rather than a person's turn. */
	| `task:${TaskKind}`;

/**
 * Background work, by what it was for. `compaction` runs on the
 * conversation's own model; the rest on a configured task / memory /
 * enhancement / embeddings / rerank model, so a model that only ever shows
 * these is doing a job, not sitting unused.
 */
export type TaskKind =
	'title' | 'topic' | 'memory' | 'dream' | 'compaction' | 'enhance' | 'embed' | 'rerank';

export interface ModelRef {
	endpointId: string;
	/** The upstream id, without the `endpoint::` prefix. */
	modelId: string;
}

export interface RecordOptions {
	/** Defaults to 1. */
	count?: number;
	/** Added to the row's running `sum`. */
	sum?: number;
	/** Also stamp this user's last use of the model. Pass it only for events
	 *  that ARE a use (a turn, a generation), not a reaction to an old one. */
	userId?: string;
	/** Event time in ms; defaults to now. Picks the UTC day bucket. */
	at?: number;
	/** The caller's transaction, when the event is written inside one. */
	tx?: Tx | DB;
}

/**
 * A stored model id (`endpoint::upstream`) as a `ModelRef`, or null for one
 * that names no endpoint — `run_python` outputs, a legacy bare id. Those have
 * no model to attribute to, so callers skip them.
 */
export function modelRefOf(storedModelId: string | null | undefined): ModelRef | null {
	if (!storedModelId) return null;
	const parsed = parseModelId(storedModelId);
	return parsed ? { endpointId: parsed.endpointId, modelId: parsed.upstreamId } : null;
}

/** The UTC day bucket for a timestamp. */
export function statsDay(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

/**
 * Add to a model's counter. Accepts a `ModelRef` or a stored
 * `endpoint::upstream` id; an id that names no endpoint is ignored.
 */
export function recordModelEvent(
	model: ModelRef | string | null | undefined,
	metric: ModelMetric,
	opts: RecordOptions = {},
): void {
	const ref = typeof model === 'string' || model == null ? modelRefOf(model) : model;
	if (!ref) return;
	const at = opts.at ?? Date.now();
	const count = opts.count ?? 1;
	const sum = opts.sum ?? 0;
	try {
		const db = opts.tx ?? getDb();
		db.insert(modelStatsDaily)
			.values({ day: statsDay(at), ...ref, metric, count, sum })
			.onConflictDoUpdate({
				target: [
					modelStatsDaily.day,
					modelStatsDaily.endpointId,
					modelStatsDaily.modelId,
					modelStatsDaily.metric,
				],
				set: {
					count: sql`${modelStatsDaily.count} + ${count}`,
					sum: sql`${modelStatsDaily.sum} + ${sum}`,
				},
			})
			.run();
		if (opts.userId) {
			db.insert(modelUserUsage)
				.values({ ...ref, userId: opts.userId, lastUsedAt: at })
				.onConflictDoUpdate({
					target: [modelUserUsage.endpointId, modelUserUsage.modelId, modelUserUsage.userId],
					set: { lastUsedAt: sql`max(${modelUserUsage.lastUsedAt}, ${at})` },
				})
				.run();
		}
	} catch (e) {
		log.warn(`failed to record ${metric} for ${ref.endpointId}::${ref.modelId}`, e);
	}
}

/**
 * Count a metric against each media row's source model — a trash, a restore, a
 * favourite — one per row. Rows that name no model (uploads, `run_python`
 * plots) are skipped by `modelRefOf`.
 */
export function recordMediaEvent(
	mediaIds: readonly string[],
	metric: ModelMetric,
	opts: Pick<RecordOptions, 'tx'> = {},
): void {
	if (mediaIds.length === 0) return;
	try {
		const db = opts.tx ?? getDb();
		const rows = db
			.select({ sourceModel: media.sourceModel, n: sql<number>`count(*)` })
			.from(media)
			.where(and(inArray(media.id, [...mediaIds]), eq(media.origin, 'generated')))
			.groupBy(media.sourceModel)
			.all();
		for (const r of rows) recordModelEvent(r.sourceModel, metric, { count: r.n, tx: opts.tx });
	} catch (e) {
		log.warn(`failed to record ${metric} for ${mediaIds.length} media`, e);
	}
}
