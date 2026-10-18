/**
 * Attribution for the reactions a send can carry — a retry, an edit, a switch
 * of model — each of which is a verdict on an EARLIER reply, not on the one
 * about to be generated. The send route calls these once it has resolved the
 * request; nothing here throws (the counter write is best-effort).
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '#lib/server/db/client.js';
import { messages } from '#lib/server/db/schema.js';
import { getSiblingAssistants } from '#lib/server/db/queries/messages.js';
import { getEndpoint } from '#lib/server/endpoints/registry.js';
import type { ChatMessage, ModelKind } from '#lib/types/api.js';
import { modelRefOf, recordModelEvent } from './model-stats';

/** An error sibling isn't a reply anyone judged — it was already counted as an
 *  `error`, and asking again is the only way past it. */
function isFailure(m: Pick<ChatMessage, 'parts' | 'finishReason'>): boolean {
	return m.finishReason === 'error' || m.parts.some((p) => p.type === 'error');
}

/** A retry of `target`: the user wanted a different answer to the same prompt. */
export function recordRetry(target: ChatMessage): void {
	if (isFailure(target)) return;
	recordModelEvent(target.modelUsed, 'retry');
	if (target.finishReason === 'cancelled') recordModelEvent(target.modelUsed, 'retry_after_cancel');
}

/**
 * An edit of a user prompt, counted against the reply that prompt had — the
 * newest assistant child, i.e. the one most recently on screen. Whether that
 * reply was STOPPED is what tells a stop the user blamed on their own prompt
 * (`edit_after_cancel`) from one they blamed on the model (`retry_after_cancel`).
 */
export function recordEdit(conversationId: string, editedMessageId: string): void {
	const reply = getDb()
		.select({ modelUsed: messages.modelUsed, finishReason: messages.finishReason })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.parentMessageId, editedMessageId),
				eq(messages.role, 'assistant'),
			),
		)
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(1)
		.get();
	if (!reply?.modelUsed) return;
	recordModelEvent(reply.modelUsed, 'edit');
	if (reply.finishReason === 'cancelled') recordModelEvent(reply.modelUsed, 'edit_after_cancel');
}

/** Chat, or a legacy row with no recorded kind (which only chat ever wrote). */
function isChatKind(kind: ModelKind | null): boolean {
	return kind === null || kind === 'chat';
}

/**
 * A conversation moving from one chat model to another. Chat → image (or back)
 * is a change of medium — a prompt drafted on a text model, then rendered — and
 * says nothing about the text model, so only chat → chat counts. A model whose
 * endpoint is no longer configured (an imported chat's dead routing) is skipped:
 * nobody chose to leave it.
 */
export function recordModelSwitch(
	from: { modelId: string; kind: ModelKind | null },
	to: { modelId: string; kind: ModelKind | null },
): void {
	if (from.modelId === to.modelId) return;
	if (!isChatKind(from.kind) || !isChatKind(to.kind)) return;
	const ref = modelRefOf(from.modelId);
	if (!ref || !getEndpoint(ref.endpointId)) return;
	recordModelEvent(ref, 'switched_away');
}

/**
 * The user resolved a side-by-side comparison by picking `winner`. Every model
 * in it is `*_shown` once and the winner's `*_win` — deliberately no loss: not
 * being picked means "not the best fit here", and the columns that were bad are
 * the ones the user deleted (`branch_deleted` / `trashed`). Models count once
 * per comparison however many columns they had, and a comparison of one model
 * against itself (several draws) says nothing about models and is skipped.
 */
export function recordComparisonPick(
	conversationId: string,
	winner: ChatMessage & { parentMessageId?: string | null },
	kind: 'fanout' | 'avatar',
): void {
	if (!winner.parentMessageId || !winner.modelUsed) return;
	const models = new Set(
		getSiblingAssistants(conversationId, winner.parentMessageId)
			.filter((m) => !isFailure(m) && m.modelUsed)
			.map((m) => m.modelUsed!),
	);
	models.add(winner.modelUsed);
	if (models.size < 2) return;
	for (const m of models) recordModelEvent(m, kind === 'fanout' ? 'fanout_shown' : 'avatar_shown');
	recordModelEvent(winner.modelUsed, kind === 'fanout' ? 'fanout_win' : 'avatar_win');
}
