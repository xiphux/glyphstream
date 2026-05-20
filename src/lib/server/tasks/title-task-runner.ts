/**
 * Shared title-task wiring used by the three response paths
 * (text stream, video stream, image sync). Centralizes:
 *   1. The "fire only on first exchange" gate (task_model configured
 *      AND conversation's title_source is still 'fallback').
 *   2. The bounded race used by callers that want to deliver the title
 *      inline rather than wait indefinitely on a slow task model.
 *
 * Both helpers swallow errors and resolve to null on failure — the
 * caller's response shape never carries a title-task error to the
 * user. Title gen is fire-and-forget by design; the background task
 * continues even after the race times out, so a slow title still
 * persists for the next refetch.
 */

import { getConversationTitleSource } from '../db/queries/conversations';
import { generateConversationTitle } from './title-generator';
import { getTaskModel } from './task-model';

/**
 * Kick off the title task for `conversationId` if (and only if) it's
 * still the first exchange — i.e., title_source is 'fallback'. Returns a
 * promise that resolves to the persisted title or null. The promise
 * never rejects.
 */
export function startTitleTaskIfFirstExchange(conversationId: string): Promise<string | null> {
	if (!getTaskModel()) return Promise.resolve(null);
	if (getConversationTitleSource(conversationId) !== 'fallback') return Promise.resolve(null);
	return generateConversationTitle(conversationId).then(
		(result) => (result && result.persisted ? result.title : null),
		(e) => {
			console.warn('[title-task] generator threw:', e);
			return null;
		}
	);
}

/**
 * Await `promise` but cap at `timeoutMs` — resolves to null on timeout
 * rather than blocking the response indefinitely. The underlying title
 * task keeps running after timeout; the caller is just no longer
 * waiting on it.
 */
export function raceTitle(
	promise: Promise<string | null>,
	timeoutMs: number
): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(null);
		}, timeoutMs);
		promise
			.then((v) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(v);
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(null);
			});
	});
}
