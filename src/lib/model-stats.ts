/**
 * Reading a `ModelStatsModel`'s raw counters as signals — the rates, the
 * flags, and which bucket of the page a model belongs in. Pure and
 * client-safe; the server only counts.
 *
 * Small samples are the trap. "3 of 3 kept" isn't a 100% model, so every flag
 * is raised on the Wilson LOWER bound of its rate — the rate the evidence
 * supports with ~95% confidence — rather than the rate itself, and never below
 * a small sample floor. How many events a flag needs then depends on how
 * extreme the rate is, which a fixed minimum-n alone can't express.
 */
import type { ModelStatsModel } from '#lib/types/api.js';

/** Below this many events a rate prints as a fraction ("2/3"), not a percent. */
export const MIN_RATE_SAMPLE = 5;

/**
 * Lower bound of the Wilson score interval for `k` successes in `n` trials.
 * 0 for no trials. z = 1.96 (~95%).
 */
export function wilsonLower(k: number, n: number, z = 1.96): number {
	if (n <= 0) return 0;
	const p = Math.min(1, Math.max(0, k / n));
	const z2 = z * z;
	const centre = p + z2 / (2 * n);
	const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
	return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export interface Rate {
	k: number;
	n: number;
}

/**
 * The evidence a flag is judged on: the Wilson lower bound, or 0 below the
 * sample floor. Wilson alone would still flag 3 retries in 3 turns (its bound
 * is ~0.44), and a rate the page prints as a bare "3/3" shouldn't carry a
 * verdict either.
 */
function evidence({ k, n }: Rate): number {
	return n < MIN_RATE_SAMPLE ? 0 : wilsonLower(k, n);
}

/** "12%", or "2/3" while the sample is too small for a percent to mean much,
 *  or null when there's nothing to divide. */
export function formatRate({ k, n }: Rate): string | null {
	if (n <= 0) return null;
	if (n < MIN_RATE_SAMPLE) return `${k}/${n}`;
	const pct = (k / n) * 100;
	return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

const c = (m: ModelStatsModel, metric: string) => m.counts[metric] ?? 0;
const s = (m: ModelStatsModel, metric: string) => m.sums[metric] ?? 0;

/** Image / video, as opposed to chat (and embedding, which only tasks use). */
export function isMediaModel(m: ModelStatsModel): boolean {
	if (m.kind) return m.kind === 'image' || m.kind === 'video';
	// Retired: the listing no longer says, so go by what it did.
	return c(m, 'generated') + c(m, 'failed') > 0;
}

/** Work done on the model's own account in the window — chat turns and
 *  generations, successful or not. Background task calls are separate. */
export function activityOf(m: ModelStatsModel): number {
	return c(m, 'turn') + c(m, 'error') + c(m, 'generated') + c(m, 'failed');
}

export function taskCallsOf(m: ModelStatsModel): number {
	return Object.entries(m.counts).reduce((n, [k, v]) => (k.startsWith('task:') ? n + v : n), 0);
}

/**
 * How long a model counts as new: first used within this many days. A
 * matter of time, not of sample size — the flags already guard that. It tells
 * a model that is barely used because it only just arrived from one that is
 * barely used because nobody picks it, and marks numbers that rest on a short
 * history and may still move.
 */
export const NEW_MODEL_DAYS = 14;

/** Whole days since the model first did work of its own (a turn or a
 *  generation), or null if it never has — a task-only model is never new. */
export function daysOfData(m: ModelStatsModel, now = Date.now()): number | null {
	if (!m.firstSeenDay) return null;
	const first = Date.parse(`${m.firstSeenDay}T00:00:00Z`);
	return Math.max(1, Math.floor((now - first) / 86_400_000) + 1);
}

export function isNewModel(m: ModelStatsModel, now = Date.now()): boolean {
	const days = daysOfData(m, now);
	return days !== null && days <= NEW_MODEL_DAYS;
}

export type ModelBucket = 'active' | 'unused' | 'retired';

/**
 * Where the page puts a model:
 * - `active`: did something in the window, or holds a configured job (a title
 *   or embeddings model is working even when it's quiet, and must never be
 *   offered up as a deletion candidate).
 * - `retired`: no longer offered and idle — history only.
 * - `unused`: offered, idle, no job. The candidates for removal.
 */
export function bucketOf(m: ModelStatsModel): ModelBucket {
	const presetChats = m.presets.reduce((n, p) => n + p.chats, 0);
	if (activityOf(m) > 0 || taskCallsOf(m) > 0 || presetChats > 0 || m.roles.length > 0) {
		return 'active';
	}
	return m.listed ? 'unused' : 'retired';
}

export interface ChatSignals {
	turns: number;
	errors: Rate;
	truncated: Rate;
	retries: Rate;
	/** Of the stops the user followed up, the share they retried (blamed the
	 *  model) rather than edited (blamed their prompt). */
	stoppedThenRetried: number;
	stoppedThenEdited: number;
	/** Turns after which the conversation moved to another chat model. */
	switchedAway: Rate;
	branchesDeleted: Rate;
	picked: Rate;
	tokensPerSecond: number | null;
}

export function chatSignals(m: ModelStatsModel): ChatSignals {
	const turns = c(m, 'turn');
	const ms = s(m, 'speed_ms');
	return {
		turns,
		errors: { k: c(m, 'error'), n: turns + c(m, 'error') },
		truncated: { k: c(m, 'truncated'), n: turns },
		retries: { k: c(m, 'retry'), n: turns },
		stoppedThenRetried: c(m, 'retry_after_cancel'),
		stoppedThenEdited: c(m, 'edit_after_cancel'),
		switchedAway: { k: Math.min(c(m, 'switched_away'), turns), n: turns },
		branchesDeleted: { k: c(m, 'branch_deleted'), n: turns },
		picked: { k: c(m, 'fanout_win'), n: c(m, 'fanout_shown') },
		tokensPerSecond: ms > 0 ? s(m, 'speed_tokens') / (ms / 1000) : null,
	};
}

export interface MediaSignals {
	generated: number;
	failures: Rate;
	favorites: Rate;
	/** Trashed by the user (net of restores), out of what was generated. */
	rejected: Rate;
	/** Built on (remixed) or worn as an avatar, out of what was generated. One
	 *  output can be used more than once, so the count is capped at the outputs
	 *  — "every one of them" is the ceiling a share can mean. */
	used: Rate;
	avatarPicked: Rate;
	picked: Rate;
	avgSeconds: number | null;
}

export function mediaSignals(m: ModelStatsModel): MediaSignals {
	const generated = c(m, 'generated');
	const timed = c(m, 'speed_ms');
	// Restores net against trashes: the counters can't tell a restore of a
	// trashed output from one of a swept one, and trashes are the commoner.
	const rejected = Math.max(0, c(m, 'trashed') - c(m, 'restored'));
	const favorites = Math.max(0, c(m, 'favorited') - c(m, 'unfavorited'));
	return {
		generated,
		failures: { k: c(m, 'failed'), n: generated + c(m, 'failed') },
		favorites: { k: Math.min(favorites, generated), n: generated },
		rejected: { k: Math.min(rejected, generated), n: generated },
		used: { k: Math.min(c(m, 'remixed') + c(m, 'avatar_set'), generated), n: generated },
		avatarPicked: { k: c(m, 'avatar_win'), n: c(m, 'avatar_shown') },
		picked: { k: c(m, 'fanout_win'), n: c(m, 'fanout_shown') },
		avgSeconds: timed > 0 ? s(m, 'speed_ms') / timed / 1000 : null,
	};
}

export interface Flag {
	label: string;
	/** `mixed` is the softer warning: a share of rejections worth knowing
	 *  about (a workflow to tweak, a replacement to try), not yet "bad". */
	tone: 'good' | 'mixed' | 'bad';
	/** Why, for a tooltip. */
	detail: string;
}

/**
 * Starting heuristics, not calibrated truths: each fires when the Wilson lower
 * bound clears its threshold, so it takes real evidence. Deliberately no flag
 * for losing comparisons — not being picked means "not the best fit", and the
 * outputs that were bad are the ones people deleted.
 */
const THRESHOLDS = {
	unreliable: 0.1,
	oftenRetried: 0.25,
	mixedRetried: 0.1,
	oftenRejected: 0.4,
	mixedRejected: 0.15,
	wellLikedFavorites: 0.15,
	oftenPicked: 0.5,
} as const;

export function flagsFor(m: ModelStatsModel): Flag[] {
	const flags: Flag[] = [];
	const pct = (x: number) => `${Math.round(x * 100)}%`;
	if (isMediaModel(m)) {
		const sig = mediaSignals(m);
		const fail = evidence(sig.failures);
		if (fail > THRESHOLDS.unreliable) {
			flags.push({
				label: 'Unreliable',
				tone: 'bad',
				detail: `At least ${pct(fail)} of generations fail`,
			});
		}
		const rej = evidence(sig.rejected);
		if (rej > THRESHOLDS.oftenRejected) {
			flags.push({
				label: 'Often deleted',
				tone: 'bad',
				detail: `At least ${pct(rej)} of outputs deleted`,
			});
		} else if (rej > THRESHOLDS.mixedRejected) {
			flags.push({
				label: 'Mixed reception',
				tone: 'mixed',
				detail: `At least ${pct(rej)} of outputs deleted`,
			});
		}
		const fav = evidence(sig.favorites);
		const picked = evidence({
			k: sig.avatarPicked.k + sig.picked.k,
			n: sig.avatarPicked.n + sig.picked.n,
		});
		if (fav > THRESHOLDS.wellLikedFavorites) {
			flags.push({
				label: 'Well liked',
				tone: 'good',
				detail: `At least ${pct(fav)} of outputs favorited`,
			});
		} else if (picked > THRESHOLDS.oftenPicked) {
			flags.push({
				label: 'Often picked',
				tone: 'good',
				detail: `Picked in at least ${pct(picked)} of comparisons`,
			});
		}
	} else {
		const sig = chatSignals(m);
		const err = evidence(sig.errors);
		if (err > THRESHOLDS.unreliable) {
			flags.push({
				label: 'Unreliable',
				tone: 'bad',
				detail: `At least ${pct(err)} of turns fail`,
			});
		}
		const retry = evidence(sig.retries);
		if (retry > THRESHOLDS.oftenRetried) {
			flags.push({
				label: 'Often retried',
				tone: 'bad',
				detail: `At least ${pct(retry)} of replies regenerated`,
			});
		} else if (retry > THRESHOLDS.mixedRetried) {
			flags.push({
				label: 'Mixed reception',
				tone: 'mixed',
				detail: `At least ${pct(retry)} of replies regenerated`,
			});
		}
		const picked = evidence(sig.picked);
		if (picked > THRESHOLDS.oftenPicked) {
			flags.push({
				label: 'Often picked',
				tone: 'good',
				detail: `Picked in at least ${pct(picked)} of comparisons`,
			});
		}
	}
	return flags;
}
