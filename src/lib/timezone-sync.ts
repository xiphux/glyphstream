/**
 * Report the browser's IANA timezone to the server, so the model is told the
 * user's today rather than the server's.
 *
 * The server has no way to know this on its own. A self-hosted GlyphStream on a
 * VPS is routinely in a different zone from the person using it, and even a
 * box under the same desk is wrong the moment its owner travels — "today" being
 * off by one is a quiet, durable source of bad answers, since the model reasons
 * confidently from whatever date it was handed.
 *
 * Fires only when the value actually differs from what's stored, so the steady
 * state is zero requests: this runs on every (app) page mount, and a PATCH per
 * navigation would be a silly price for a string that changes a few times a year.
 */
import type { UserPreferences } from '$lib/types/api';

/** The browser's zone, or null where `Intl` can't resolve one. */
export function detectTimeZone(): string | null {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	} catch {
		return null;
	}
}

/**
 * Sync the detected zone into the user's preferences if it has changed.
 * Resolves to the zone that is now stored, or null if there was nothing to do.
 *
 * Failures are swallowed: this is a background nicety, and a user whose network
 * blipped should not see an error toast about their timezone.
 */
export async function syncTimeZone(prefs: UserPreferences | null): Promise<string | null> {
	const detected = detectTimeZone();
	if (!detected || detected === prefs?.timezone) return null;

	try {
		const res = await fetch('/api/user/preferences', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ timezone: detected }),
		});
		return res.ok ? detected : null;
	} catch {
		return null;
	}
}
