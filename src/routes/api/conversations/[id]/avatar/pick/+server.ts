/**
 * POST /api/conversations/:id/avatar/pick
 *
 * Resolve a multi-model avatar comparison: make one of the drawn portraits the
 * conversation's face AND make its branch the active thread, so the user
 * continues from the face they chose.
 *
 * One endpoint rather than the client calling ../avatar and then
 * .../messages/:id/select, because those two are a single user action ("use
 * this one") and splitting them across two round trips gives the failure a
 * seam: land one and lose the other and the conversation shows a face from a
 * branch it isn't on. Here a rejected pick changes nothing.
 *
 * Not folded into `selectBranch` itself, which is ordinary branch navigation and
 * has no business repainting the conversation.
 *
 * The single-model draw never comes through here — it applies server-side from
 * the relay (see ../generate), precisely so it survives a client that doesn't.
 * A comparison can't: there is no winner until someone says so.
 */

import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	getConversationMeta,
	getFanoutParent,
	setConversationAvatar,
} from '$lib/server/db/queries/conversations';
import { getMessage, selectBranch } from '$lib/server/db/queries/messages';
import type { RequestHandler } from './$types';

interface PickAvatarBody {
	/** The portrait message to adopt — an assistant message in this conversation
	 *  carrying an image part. */
	messageId?: unknown;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<PickAvatarBody>(request);
	if (typeof body.messageId !== 'string' || !body.messageId) {
		error(400, "'messageId' is required");
	}

	// Ownership first: `getMessage` is scoped to the conversation but not to the
	// user, so without this a message id from a thread of ours could be picked
	// into someone else's conversation.
	if (!getConversationMeta(params.id, locals.user.id)) error(404, 'Conversation not found');

	const message = getMessage(params.id, body.messageId);
	if (!message) error(404, 'Message not found');
	if (message.role !== 'assistant') error(400, 'Only an assistant message can be an avatar');

	// The FIRST image part, matching what the grid column shows: a portrait
	// message has exactly one, and picking silently among several would make the
	// face depend on part ordering.
	const image = message.parts.find((p) => p.type === 'image');
	if (!image) error(400, 'That message has no image to use as an avatar');

	// And it has to be a candidate from the comparison that is actually parked
	// here. Without this the endpoint's contract is quietly wider than its name:
	// "set the avatar" would also navigate the thread to any assistant message in
	// the conversation that happens to carry an image. Nothing today sends
	// anything but a grid column — this is the same assertion ../prepare and
	// ../generate already make about their own anchors, made at the third door.
	if (getFanoutParent(params.id, locals.user.id) !== message.parentMessageId) {
		error(409, 'That comparison is no longer open.');
	}

	// Avatar before branch. Both orders leave the same state on success; this one
	// fails better — `setConversationAvatar` is the half that can legitimately
	// refuse (media reaped, wrong kind), and refusing before the branch moves
	// leaves the user exactly where they were rather than on a branch they didn't
	// ask to be on with the old face still showing.
	const applied = setConversationAvatar(params.id, locals.user.id, image.mediaId);
	if (!applied.ok) {
		if (applied.reason === 'not_found') error(404, 'Conversation not found');
		error(400, 'Media not found');
	}

	// Also clears the parked-fan-out marker, which is what takes the grid down.
	const selected = selectBranch(params.id, body.messageId);
	if (!selected) error(404, 'Message not found');

	return json({ ok: true, newActiveLeaf: selected.newActiveLeaf });
};
