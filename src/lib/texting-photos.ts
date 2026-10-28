/**
 * A reply's `[photo: …]` markers, numbered the way its photos are stored
 * (`message_images.marker_index`), in either reply style. A developed photo is
 * kept on the reply itself, so where a photo stands is just a question of its
 * versions — see `ChatMessage.images`.
 *
 * The numbering is `textingItems`' for both styles, so a photo keeps its
 * number whichever bubble draws it: a marker is a paragraph that is nothing
 * but `[photo: …]`, after any `Name: ` prefix.
 */
import { messageToBlocks, type RenderBlock } from './chat-render.js';
import {
	extractPlainSpeaker,
	extractSpeaker,
	photoDescription,
	splitTopLevelHtml,
	textingItems,
} from './texting.js';
import type { ChatMessage } from './types/api.js';

/** A run of a reply's blocks, or one of its photos. */
export type PhotoSegment =
	{ kind: 'blocks'; blocks: RenderBlock[] } | { kind: 'photo'; index: number; description: string };

/**
 * A standard reply's blocks, cut around its photo markers so each photo can be
 * drawn where the model put it. Paragraphs around a marker stay whole, and a
 * block with no marker comes back untouched.
 *
 * `live` is a reply still arriving: a last paragraph that has begun a marker
 * but not finished it is held back rather than shown as raw text.
 */
export function splitAtPhotos(blocks: RenderBlock[], live = false): PhotoSegment[] {
	const out: PhotoSegment[] = [];
	let run: RenderBlock[] = [];
	let photos = 0;
	const flush = () => {
		if (run.length) out.push({ kind: 'blocks', blocks: run });
		run = [];
	};
	const photo = (description: string) => {
		flush();
		out.push({ kind: 'photo', index: photos++, description });
	};
	blocks.forEach((block, b) => {
		const last = live && b === blocks.length - 1;
		// No marker in it (or, at the live end, not even the start of one): as it
		// came — not cut and rejoined, which is work and can't add anything.
		const text = block.type === 'html' ? block.html : block.type === 'plain-text' ? block.text : '';
		if (!(last ? text.includes('[') : /\[photo/i.test(text))) {
			run.push(block);
			return;
		}
		if (block.type === 'html') {
			// Dividers kept: in a standard reply they're part of what was written.
			const chunks = splitTopLevelHtml(block.html, true);
			let kept: string[] = [];
			chunks.forEach((chunk, c) => {
				const description = photoDescription({ html: extractSpeaker(chunk).html });
				if (description !== null) {
					if (kept.length) run.push({ type: 'html', html: kept.join('\n') });
					kept = [];
					photo(description);
				} else if (!(
					last &&
					c === chunks.length - 1 &&
					// A marker is a paragraph, so only a paragraph can be one half
					// typed — a code line or list item ending `[` is just text.
					/^<p[\s>]/.test(chunk) &&
					unfinished(chunk.replace(/<[^>]*>/g, ''))
				)) {
					kept.push(chunk);
				}
			});
			if (kept.length) run.push({ type: 'html', html: kept.join('\n') });
		} else if (block.type === 'plain-text' && !block.ownReaction) {
			const paras = block.text.split(/\n\s*\n/);
			let kept: string[] = [];
			paras.forEach((para, p) => {
				const description = photoDescription({ text: extractPlainSpeaker(para.trim()).text });
				if (description !== null) {
					if (kept.length) run.push({ type: 'plain-text', text: kept.join('\n\n') });
					kept = [];
					photo(description);
				} else if (!(last && p === paras.length - 1 && unfinished(para))) {
					kept.push(para);
				}
			});
			if (kept.length) run.push({ type: 'plain-text', text: kept.join('\n\n') });
		} else {
			run.push(block);
		}
	});
	flush();
	return out;
}

/** A paragraph's text that has begun a photo marker it hasn't closed yet —
 *  `[`, `[pho`, `[photo: a dog on`, after any `Name: ` prefix. */
function unfinished(text: string): boolean {
	return /^[*_]{0,2}(?:[^:\n]{1,30}:\s)?\[(?:p(?:h(?:o(?:t(?:o(?::[^\]]*)?)?)?)?)?)?$/i.test(
		text.trim(),
	);
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
