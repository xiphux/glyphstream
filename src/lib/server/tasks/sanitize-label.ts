import { truncateEllipsis } from '$lib/text';

/**
 * Strip the decorations LLMs habitually add to short single-line outputs even
 * when explicitly told not to, then length-cap. Shared by the conversation-title
 * and memory-topic tasks, which differ only in the leading label word and the
 * character cap.
 *
 * Steps: drop a leading "<label>:" / "<label> -" prefix, strip a single pair of
 * surrounding quotes (ASCII or smart), collapse internal whitespace runs to
 * single spaces (these outputs are always one line), drop trailing sentence
 * punctuation, and hard-cap the length so a runaway model can't emit a 10kb
 * "title".
 */
const QUOTE_PAIRS: Array<[string, string]> = [
	['"', '"'],
	["'", "'"],
	['“', '”'],
	['‘', '’'],
	['«', '»'],
];

export function sanitizeModelLabel(
	raw: string,
	opts: { labelWord: string; maxChars: number },
): string {
	let s = raw.trim();
	// Strip a leading "<label>:" / "<label> -" prefix a model might add. labelWord
	// is a fixed internal literal ('title' / 'topic'), so no escaping needed.
	s = s.replace(new RegExp(`^\\s*${opts.labelWord}\\s*[:\\-]\\s*`, 'i'), '');
	// Strip surrounding quotes — a single pair only; repeated pairs are likely
	// intentional.
	for (const [open, close] of QUOTE_PAIRS) {
		if (s.startsWith(open) && s.endsWith(close) && s.length >= 2) {
			s = s.slice(open.length, s.length - close.length).trim();
			break;
		}
	}
	s = s.replace(/\s+/g, ' ');
	s = s.replace(/[.!?;:,]+$/, '').trim();
	return truncateEllipsis(s, opts.maxChars);
}
