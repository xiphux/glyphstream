/**
 * Friendly greeting helpers for the new-chat page header.
 *
 * Time-of-day phrasing matches the user's local clock (we always pass the
 * client `Date()` in). Fallback ordering for the user's first name keeps
 * us friendly even if a GitHub display name isn't set.
 */

// Per-slot variation lists. Morning / afternoon / evening get 2-3
// variations to add a bit of warmth without being twee; late-night and
// early-morning slots stay as singletons because "Burning the midnight
// oil" and "Still up" are the iconic ones — diluting them with 3
// variations each would soften the punchline.
//
// Variations are picked via dateHash() below — same date → same
// greeting, so refreshing the page doesn't churn. Different day → roll
// the dice again.
const MORNING = ['Good morning', 'Top of the morning', 'Morning'];
const AFTERNOON = ['Good afternoon', 'Afternoon', "Hope your day's going well"];
const EVENING = ['Good evening', 'Evening', 'Hope your day went well'];

/** Stable per-day hash: same number for any Date in the same calendar
 * day, regardless of time-of-day. Lets the variation picker key off
 * "today" without jittering on every page refresh. */
function dayHash(now: Date): number {
	return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

export function timeOfDayGreeting(now: Date): string {
	const h = now.getHours();
	if (h < 5) return 'Still up';
	const seed = dayHash(now);
	if (h < 12) return MORNING[seed % MORNING.length];
	if (h < 17) return AFTERNOON[seed % AFTERNOON.length];
	if (h < 22) return EVENING[seed % EVENING.length];
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

/**
 * Preferred first name with the user's explicit Preferences > Name field
 * winning over any GitHub-derived name. The Preferences name is exactly
 * "how I want to be referred to," so it's the right input for greeting
 * lines and the user label on message bubbles. Falls through to the
 * GitHub-name extraction when the preference is empty or whitespace-only.
 *
 * Use this in any user-facing surface that addresses the user by name.
 */
export function preferredFirstName(
	preferenceName: string | null | undefined,
	displayName: string | null,
	fallback: string,
): string {
	const fromPref = preferenceName?.trim();
	if (fromPref) return fromPref;
	return firstName(displayName, fallback);
}
