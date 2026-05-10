/**
 * Per-conversation in-flight registry. Lets the cancel endpoint reach into
 * an active generation and abort the upstream call (chat / image fetch) or
 * issue a bridge-side cancel (video).
 *
 * Module-level Map is fine for single-process. With multiple replicas this
 * would need a shared store; that's a v2 concern, not a v1 one.
 *
 * Why a registry instead of just listening for client disconnects: the
 * design intentionally lets the recorder finish on flaky connections (close
 * laptop, come back later, message is there). We only want to abort upstream
 * when the user *explicitly* stops — which is a separate signal from the
 * underlying TCP close.
 */

import type { LoadedEndpoint } from '../endpoints/config';

export interface InFlightEntry {
	controller: AbortController;
	endpoint: LoadedEndpoint;
	/** For video kind: bridge-side job id, set as soon as videoCreate returns. */
	videoJobId?: string;
}

const inFlight = new Map<string, InFlightEntry>();

/**
 * Register a new in-flight generation. If an entry already exists for this
 * conversation (rare — UI prevents send while busy, but defend anyway),
 * cancel it first so we never have two upstream calls racing.
 */
export function registerInFlight(
	conversationId: string,
	endpoint: LoadedEndpoint
): InFlightEntry {
	const prior = inFlight.get(conversationId);
	if (prior) prior.controller.abort();
	const entry: InFlightEntry = { controller: new AbortController(), endpoint };
	inFlight.set(conversationId, entry);
	return entry;
}

export function clearInFlight(conversationId: string, entry: InFlightEntry): void {
	// Only clear if the slot still holds *our* entry — protects against the
	// case where a new generation has already overwritten this slot.
	const current = inFlight.get(conversationId);
	if (current === entry) inFlight.delete(conversationId);
}

export function setVideoJobId(conversationId: string, jobId: string): void {
	const entry = inFlight.get(conversationId);
	if (entry) entry.videoJobId = jobId;
}

export function getInFlight(conversationId: string): InFlightEntry | undefined {
	return inFlight.get(conversationId);
}

/** Test/dev only. */
export function resetInFlight(): void {
	for (const entry of inFlight.values()) entry.controller.abort();
	inFlight.clear();
}
