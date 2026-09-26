/**
 * App lock — the client-safe half (the timeout choices and the wire status).
 * Enforcement lives in `$lib/server/auth/app-lock.ts`.
 */

/**
 * How long an installed-app session may go unused before it needs a passkey.
 *
 * There is no "immediately": the lock is an idle clock the server keeps, fed by
 * the app's own requests plus a visible-only keep-alive (see
 * `APP_LOCK_KEEPALIVE_MS`), so the shortest useful window has to comfortably
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
 * Keep-alive cadence while the installed app is visible. Well under the
 * shortest timeout, and under the server's extension throttle's worst case
 * (see `evaluateAppLock`): a request slides the window at most a quarter of the
 * timeout late, so with a one-minute timeout any gap under ~45s is safe.
 */
export const APP_LOCK_KEEPALIVE_MS = 20_000;

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
