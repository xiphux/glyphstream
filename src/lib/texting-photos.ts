/**
 * A texting reply's `[photo: …]` markers, numbered the way its photos are
 * stored (`message_images.marker_index`). A developed photo is kept on the
 * reply itself, so where a photo stands is just a question of its versions —
 * see `ChatMessage.images`.
 */
import { messageToBlocks } from './chat-render.js';
import { textingItems } from './texting.js';
import type { ChatMessage } from './types/api.js';

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
