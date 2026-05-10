/**
 * Friendly greeting helpers for the new-chat page header.
 *
 * Time-of-day phrasing matches the user's local clock (we always pass the
 * client `Date()` in). Fallback ordering for the user's first name keeps
 * us friendly even if a GitHub display name isn't set.
 */

export function timeOfDayGreeting(now: Date): string {
	const h = now.getHours();
	if (h < 5) return 'Still up';
	if (h < 12) return 'Good morning';
	if (h < 17) return 'Good afternoon';
	if (h < 22) return 'Good evening';
	return 'Burning the midnight oil';
}

/**
 * Best-effort first name. GitHub's `name` field is usually "First Last"
 * but isn't guaranteed (some users only set a single name, some leave it
 * blank). On blank we fall back to the GitHub login so we always have
 * *something* to greet with.
 */
export function firstName(displayName: string | null, fallback: string): string {
	if (!displayName) return fallback;
	const [first] = displayName.trim().split(/\s+/);
	return first || fallback;
}
