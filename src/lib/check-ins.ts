/**
 * Check-ins: the assistant saying it will get back to the user later, and then
 * doing so. A conversation can check in only if its preset allows it
 * (`checkIns`, on by default for a texting preset, off for a standard one).
 *
 * A reply that ends with `[later 1h: ask how the interview went]` sets a
 * check-in (see `server/check-ins/`). If the reply is still the end of the
 * thread when the hour is up — the user hasn't answered, regenerated it or
 * moved to another branch — the app sends the model a reminder in the user's
 * place, and its reply arrives as though it had reached out of its own accord. The
 * reminder is a user-role row so the conversation still alternates the way
 * every chat template expects, but it is drawn as a divider, not as something
 * the user said.
 *
 * Client-safe: the marker is parsed here for both the server, which schedules
 * from it, and the bubbles of either reply style, which hide it.
 */
import type { ChatMessage } from './types/api';

export const MIN_CHECK_IN_DELAY_MS = 5 * 60_000;
export const MAX_CHECK_IN_DELAY_MS = 24 * 3_600_000;

const MIN_GRACE_MS = 30 * 60_000;

/** How late a check-in may still fire: half an hour, or a quarter of its delay
 *  if that's longer — a day's wait can stand to be a few hours late; an
 *  hour's can't. Past it the runner drops the check-in, and the page stops
 *  waiting for it. */
export function graceFor(checkIn: { fireAt: number; createdAt: number }): number {
	return Math.max(MIN_GRACE_MS, (checkIn.fireAt - checkIn.createdAt) / 4);
}

/** Check-ins that may fire in a row with no answer from the user. A real person
 *  double-texts; they don't keep going all night. */
export const MAX_UNANSWERED_CHECK_INS = 2;

/** What the model writes, alone, when the moment for its check-in has passed.
 *  Told to it in the reminder rather than the system prompt, which is re-sent
 *  on every turn. */
export const CHECK_IN_SKIP = '[no text]';

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const DELAY_PART =
	/\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])\s*(?:,\s*|and\s+)?/iy;

/**
 * A delay such as `1h`, `90m`, `1h 30m`, `1h30m`, `2 hours` or `1.5h`, in ms, clamped to
 * the allowed range. Null when it isn't one.
 */
export function parseDelay(input: string): number | null {
	const s = input.trim().replace(/^in\s+/i, '');
	if (!s) return null;
	let total = 0;
	DELAY_PART.lastIndex = 0;
	while (DELAY_PART.lastIndex < s.length) {
		const m = DELAY_PART.exec(s);
		if (!m) return null;
		total += Number(m[1]) * UNIT_MS[m[2][0].toLowerCase()];
	}
	if (!(total > 0)) return null;
	return Math.min(MAX_CHECK_IN_DELAY_MS, Math.max(MIN_CHECK_IN_DELAY_MS, Math.round(total)));
}

/** A note is a reminder to self, a line or two. It is stored, then sent back
 *  as the reminder in a turn nobody is watching, so one the model was steered
 *  into writing (by a page it read, say) can't be a whole prompt. */
/** In code points, so an emoji isn't cut in half. */
const MAX_NOTE_CHARS = 280;

export interface CheckInMarker {
	delayMs: number;
	note: string;
}

/** `[later <delay>: <note>]`, optionally italic or bold, like a photo marker. */
const MARKER_HTML =
	/^<p>(?:<(?:em|strong)>)?\[later\s+([^:\]]+?):\s*([^\]]+?)\s*\](?:<\/(?:em|strong)>)?<\/p>$/i;
const MARKER_TEXT = /^([*_]{0,2})\[later\s+([^:\]]+?):\s*([^\]]+?)\s*\]\1$/i;

function decodeHtml(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.trim();
}

/** The check-in a single text sets, or null when the text isn't a marker. A
 *  marker whose delay doesn't parse isn't one: it shows as the text it is. */
export function checkInMarker(text: { html: string } | { text: string }): CheckInMarker | null {
	let delay: string;
	let note: string;
	if ('html' in text) {
		const m = MARKER_HTML.exec(text.html.trim());
		if (!m) return null;
		delay = decodeHtml(m[1]);
		note = decodeHtml(m[2]);
	} else {
		const m = MARKER_TEXT.exec(text.text.trim());
		if (!m) return null;
		delay = m[2];
		note = m[3].trim();
	}
	const delayMs = parseDelay(delay);
	return delayMs === null || !note
		? null
		: { delayMs, note: [...note].slice(0, MAX_NOTE_CHARS).join('') };
}

/** What the note under a reply shows while its check-in is pending. Absent
 *  otherwise — one that fired, was cancelled or went stale shows nothing. */
export interface PendingCheckInNote {
	fireAt: number;
	onCancel: () => void;
}

/** Whether a message is a check-in reminder (drawn as a divider). */
export function isCheckInMessage(m: Pick<ChatMessage, 'role' | 'parts'>): boolean {
	return m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.checkIn === true);
}

/** Whether a reply to a reminder is the model passing on it. */
export function isCheckInSkip(text: string): boolean {
	return /^[*_]{0,2}\[no text\][*_]{0,2}$/i.test(text.trim()) || text.trim() === '';
}
