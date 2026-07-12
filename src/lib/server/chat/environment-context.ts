/**
 * The environment preamble — what the model needs to know about *now*.
 *
 * Today this is one line: the date. Nothing in the payload used to carry it, so
 * the model's only options were to burn a full `get_current_time` round-trip
 * (prefill + decode, just to learn the day) or — far more often — to quietly
 * assume its training cutoff was the present. That second failure is the
 * expensive one: it's silent, and it poisons every relative-date judgement
 * ("last Tuesday", "is that library version still current?", "how old is this
 * changelog?") without ever announcing itself.
 *
 * DATE ONLY, deliberately — no time of day. The system prompt sits at the front
 * of the prefix, so anything in it that changes between two turns invalidates
 * the upstream's KV/prefix cache for the entire conversation. A clock ticking to
 * the second would do that on EVERY turn; a date changes once, at midnight, and
 * only for a conversation that happens to span it. `get_current_time` remains
 * registered for genuine time-of-day and other-timezone questions, which are
 * both rarer and genuinely worth a round-trip.
 */

/**
 * Rendered in the USER's timezone, reported by their browser and stored on their
 * preferences — not the server's. On a self-hosted box those often differ (a VPS
 * in another region, a user who travels), and "today" being off by a day is
 * precisely the class of error this block exists to prevent. Falls back to the
 * server's own zone until a browser has reported one.
 *
 * The zone is named explicitly, so the model knows the frame of reference rather
 * than assuming UTC.
 */
export function composeEnvironmentBlock(
	now: Date = new Date(),
	userTimeZone: string | null = null,
): string {
	const timeZone = resolveTimeZone(userTimeZone);
	const date = new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		timeZone,
	}).format(now);
	return `The current date is ${date} (${timeZone}). Use this rather than assuming a date from your training data; call get_current_time if you need the time of day or another timezone.`;
}

/**
 * The user's zone if we have a valid one, else the server's.
 *
 * Re-validates even though `coerceTimezone` already did on write: a row persisted
 * by an older build, or one whose zone an ICU update has since retired, would
 * otherwise make `Intl.DateTimeFormat` throw here — on the send path, where the
 * blast radius is "this user cannot chat at all".
 */
export function resolveTimeZone(userTimeZone: string | null): string {
	if (userTimeZone) {
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: userTimeZone });
			return userTimeZone;
		} catch {
			// fall through to the server's zone
		}
	}
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
