/**
 * App lock — the client-safe half (the timeout choices and the wire status).
 * Enforcement lives in `$lib/server/auth/app-lock.ts`.
 */

/**
 * How long an installed-app session may go unused before it needs a passkey.
 *
 * There is no "immediately": the lock is an idle clock the server keeps, fed by
 * the app's own requests plus a visible-only keep-alive (see
 * `appLockKeepAliveMs`), so the shortest useful window has to comfortably
 * clear the keep-alive interval — or someone reading a long thread without
 * touching anything would lock mid-read.
 */
export const APP_LOCK_TIMEOUTS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export function isAppLockTimeout(v: unknown): v is (typeof APP_LOCK_TIMEOUTS_MS)[number] {
	return typeof v === 'number' && (APP_LOCK_TIMEOUTS_MS as readonly number[]).includes(v);
}

export function describeAppLockTimeout(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes >= 60 && minutes % 60 === 0) {
		const hours = minutes / 60;
		return hours === 1 ? '1 hour' : `${hours} hours`;
	}
	return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * Keep-alive cadence while the installed app is visible, for a given window.
 *
 * The safety bound is the server's extension throttle (see `evaluateAppLock`):
 * a request slides the window only once it has decayed by
 * `min(30s, timeout/4)`, so the gap between requests must stay under
 * `timeout - min(30s, timeout/4)` — 45s for the one-minute window. A quarter
 * of the timeout clears that for every window with room to spare, floored at
 * 20s so the shortest window keeps a margin too. Scaling matters on a phone:
 * a flat 20s against the one-hour window is ~180 radio wake-ups an hour to
 * defend a lapse that is 60 minutes away.
 */
export function appLockKeepAliveMs(timeoutMs: number): number {
	return Math.max(20_000, timeoutMs / 4);
}

/** HTTP status a locked session gets from the API surface. */
export const APP_LOCKED_STATUS = 423;

/**
 * `/unlock?from=` target, restricted to a same-origin path.
 *
 * Parsed, not prefix-matched. The URL parser strips ASCII tab and newline
 * before it resolves anything, so `"/\t/evil.test"` passes a `//` check yet
 * lands on evil.test once a browser follows it out of a `Location` header.
 * Resolving against a throwaway origin and requiring it to survive is the only
 * check that agrees with the browser by construction — but not on its own:
 * resolution also removes dot segments (and turns `\` into `/`), so
 * `"/.//evil.test"` keeps the origin yet comes out as the path `//evil.test`,
 * which is protocol-relative once it's a `Location` header. So the RESULT
 * must not start with `//` either.
 */
export function safeUnlockReturn(from: string | null | undefined): string {
	if (!from || !from.startsWith('/')) return '/';
	const base = 'http://unlock.invalid';
	let url: URL;
	try {
		url = new URL(from, base);
	} catch {
		return '/';
	}
	if (url.origin !== base || url.pathname.startsWith('//')) return '/';
	return url.pathname + url.search + url.hash;
}

/**
 * Running as a home-screen / installed app. Client-only; false during SSR.
 * `navigator.standalone` is older iOS's non-standard spelling.
 */
export function isStandaloneDisplay(): boolean {
	if (typeof window === 'undefined') return false;
	if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
	return (navigator as unknown as { standalone?: boolean }).standalone === true;
}
