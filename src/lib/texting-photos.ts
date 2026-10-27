/**
 * Where texting photos stand on the active branch: which markers have been
 * developed, and whether — and under what — the user can develop one now.
 *
 * A developed photo is an assistant message of its own, hung under the reply
 * that sent it the way an avatar portrait hangs under its description (the
 * avatar draw pipeline is what develops it). A reply with several photos chains
 * them: the second hangs under the first, so the thread stays one line and they
 * arrive in the order they were developed. That chain is what this reads.
 *
 * Developing is only offered while the reply is the latest thing in the thread
 * — nothing below it but its own photos. That is the rule an avatar comparison
 * already lives by, for the same reason: a comparison parks the thread on the
 * photo's anchor while the user chooses, which would hide anything beyond it,
 * and a photo hung under a reply that already has an answer would branch away
 * from that answer.
 */
import { lastReplyMessage, messageToBlocks } from './chat-render.js';
import { textingItems } from './texting.js';
import type { ChatMessage, PhotoOrigin } from './types/api.js';

/** The marker a developed photo came from, or null for any other message. */
export function photoOriginOf(m: ChatMessage): PhotoOrigin | null {
	if (m.role !== 'assistant') return null;
	for (const p of m.parts) if (p.type === 'image' && p.photo) return p.photo;
	return null;
}

/** For each reply on the branch, which of its markers have arrived as photos. */
export function developedPhotos(messages: ChatMessage[]): Map<string, Set<number>> {
	const out = new Map<string, Set<number>>();
	for (const m of messages) {
		const origin = photoOriginOf(m);
		if (!origin) continue;
		let set = out.get(origin.sourceMessageId);
		if (!set) out.set(origin.sourceMessageId, (set = new Set()));
		set.add(origin.index);
	}
	return out;
}

/** A failed draw: what the media relay leaves behind when an image model errors —
 *  an assistant row holding only an error. */
function isFailedDraw(m: ChatMessage): boolean {
	return m.role === 'assistant' && m.parts.length > 0 && m.parts.every((p) => p.type === 'error');
}

/** The reply whose photos can be developed right now, and where a new one goes. */
export interface PhotoChain {
	replyId: string;
	/** The message a newly developed photo hangs under: the reply, or the last
	 *  photo after it. */
	anchorId: string;
	/** The photo at the end of the thread, which can be developed again (as a
	 *  sibling under its own parent). Null when none has arrived — or when the
	 *  last attempt failed, since the failure is what sits at the end then. */
	leafPhoto: ChatMessage | null;
	/** A failed draw at the end of the thread. The next attempt replaces it:
	 *  it's a sibling of the failure, so the failure is the leaf it takes over. */
	failedLeafId: string | null;
}

export function photoChain(messages: ChatMessage[]): PhotoChain | null {
	const leaf = lastReplyMessage(messages);
	if (!leaf || leaf.role !== 'assistant') return null;
	let i = messages.indexOf(leaf);
	let failedLeafId: string | null = null;
	if (isFailedDraw(leaf)) {
		failedLeafId = leaf.id;
		i--;
	}
	const photos: ChatMessage[] = [];
	while (i >= 0 && photoOriginOf(messages[i])) photos.unshift(messages[i--]);
	const reply = messages[i];
	if (!reply || reply.role !== 'assistant' || isFailedDraw(reply)) return null;
	// Every photo between the reply and the end must be the reply's own: a photo
	// from an earlier reply followed by an unrelated one means this isn't a chain.
	if (photos.some((p) => photoOriginOf(p)!.sourceMessageId !== reply.id)) return null;
	const last = photos.at(-1);
	return {
		replyId: reply.id,
		anchorId: (last ?? reply).id,
		leafPhoto: failedLeafId === null ? (last ?? null) : null,
		failedLeafId,
	};
}

/** A reply's photo markers as the bubbles number them, with who sent each. */
export function photoMarkers(
	reply: ChatMessage,
	assistantLabel: string,
): Array<{ index: number; description: string; speaker: string | null }> {
	const out: Array<{ index: number; description: string; speaker: string | null }> = [];
	for (const item of textingItems(messageToBlocks(reply, new Map()), assistantLabel)) {
		if (item.kind === 'photo') {
			out.push({ index: item.index, description: item.description, speaker: item.speaker });
		}
	}
	return out;
}
