/**
 * The opt-in per-user cap on generations in flight
 * (`[limits] max_queued_generations_per_user`). One invitee shouldn't be able to
 * fill a shared GPU's queue; the owner of a one-person install, who may queue a
 * thousand images overnight, sets nothing and is never capped. Admins are exempt
 * either way.
 */
import { error } from '@sveltejs/kit';
import { getMaxQueuedGenerationsPerUser } from '../endpoints/config';
import { ownedConversationIds } from '../db/queries/conversations';
import { activeConversationIds, countInFlight } from '../streaming/in-flight';

/** 429 when a capped user already has the configured number in flight. Call it
 *  before anything is persisted for the new request. */
export function enforceGenerationCap(user: { id: string; role: 'admin' | 'user' }): void {
	if (user.role === 'admin') return;
	const max = getMaxQueuedGenerationsPerUser();
	if (max === null) return;
	const mine = ownedConversationIds(user.id, activeConversationIds());
	if (countInFlight(mine) >= max) {
		error(
			429,
			`You have ${max} generations queued or running, the most this server allows per person. Try again when some finish.`,
		);
	}
}
