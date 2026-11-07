/**
 * Scenes in a 'character' conversation: whether the two sides are texting or
 * together in person. Either side changes it by writing a marker as a
 * paragraph of its own — `[texting]` or `[in person]` — the model where the
 * story moves on, the user through the composer's scene switch, which puts one
 * at the top of their message.
 *
 * The current scene is never stored as conversation state: it is the last
 * marker on the branch, or the conversation's starting scene before any. So a
 * retry, an edit or a branch switch carries its scene with it, and what the
 * model is sent back — the messages as written, markers included — is exactly
 * what the app read. `messages.scene` caches each row's own last marker only so
 * the server can find the scene at the top of a window without reading every
 * message above it.
 *
 * Client-safe: the server reads the stored text with these, the chat page the
 * same text, so the two never disagree about where a scene changed.
 */
import { extractPlainSpeaker } from './speaker';
import type { MessagePart, Scene } from './types/api';

export type { Scene };

/** `[texting]` / `[in person]` (or `in-person`), case-insensitive, optionally
 *  italic or bold, like the other markers. */
const MARKER_HTML =
	/^<p>(?:<(?:em|strong)>)?\[\s*(texting|in[ -]person)\s*\](?:<\/(?:em|strong)>)?<\/p>$/i;
const MARKER_TEXT = /^([*_]{0,2})\[\s*(texting|in[ -]person)\s*\]\1$/i;

function toScene(word: string): Scene {
	return word.toLowerCase() === 'texting' ? 'texting' : 'in_person';
}

/** The scene a single paragraph switches to, or null when it isn't a marker. */
export function sceneMarker(text: { html: string } | { text: string }): Scene | null {
	if ('html' in text) {
		const m = MARKER_HTML.exec(text.html.trim());
		return m ? toScene(m[1]) : null;
	}
	const m = MARKER_TEXT.exec(text.text.trim());
	return m ? toScene(m[2]) : null;
}

/** The marker a scene is switched to with. */
export function sceneMarkerText(scene: Scene): string {
	return scene === 'texting' ? '[texting]' : '[in person]';
}

/** The scene a plain-text paragraph switches to. A `Name: ` in front still
 *  counts — a model signing its lines signs its markers too — because the
 *  bubbles read it that way (`textingItems`), and the scene the thread is in
 *  must be the one it was drawn in. */
function paragraphScene(para: string): Scene | null {
	return sceneMarker(extractPlainSpeaker(para.trim()));
}

/** The last scene marker in some text, split into paragraphs on blank lines. */
export function lastSceneIn(text: string): Scene | null {
	let scene: Scene | null = null;
	for (const para of text.split(/\n\s*\n/)) scene = paragraphScene(para) ?? scene;
	return scene;
}

/** The last scene marker in a message's text parts, or null for none — what
 *  `messages.scene` stores. */
export function lastSceneInParts(parts: readonly MessagePart[]): Scene | null {
	let scene: Scene | null = null;
	for (const part of parts) {
		if (part.type === 'text') scene = lastSceneIn(part.text) ?? scene;
	}
	return scene;
}

/** Some text without its scene markers, for wherever a marker would show as
 *  words (a notification's preview, a user bubble). */
export function withoutSceneMarkers(text: string): string {
	return text
		.split(/\n\s*\n/)
		.filter((para) => paragraphScene(para) === null)
		.join('\n\n')
		.trim();
}
