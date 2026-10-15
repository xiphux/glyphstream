import { goto, refreshAll } from '$app/navigation';
import { navigating } from '$app/state';
import { resolve } from '$app/paths';
import { APP_LOCK_KEEPALIVE_PATH, APP_LOCKED_STATUS } from '#lib/app-lock.js';

const CHECK_TIMEOUT_MS = 8_000;

/**
 * App lock (see server/auth/app-lock.ts). The server enforces it; this is
 * the installed app's half. `sliding` means the idle clock runs here, so:
 *  - a visible-only keep-alive feeds it, or reading a long thread without
 *    touching anything would lock mid-read. iOS suspends timers in the
 *    background, which is exactly what lets the clock run out there;
 *  - the page is covered the moment it's hidden, so neither the app
 *    switcher's snapshot nor the first frame of a resume shows the thread;
 *  - a resume (BOTH events — see CLAUDE.md) asks the server before
 *    uncovering, and goes to /unlock if the window has lapsed.
 * Fails closed: a check that can't reach the server leaves the cover up
 * and retries on the next keep-alive tick or when connectivity returns.
 *
 * One check at a time, and only the CURRENT one may act on its answer. A
 * keep-alive can be in flight when the app is suspended, and it may settle
 * long after the resume — rejected ("network connection was lost"), or with
 * a 200 that predates the lapse. So a resume aborts it and asks afresh, as
 * does going hidden, and a stalled request is cut off by a timeout rather
 * than holding the slot (and silently stopping every later check) forever.
 *
 * One per layout instance, never a module singleton: it holds a user's lock
 * state, and module state is shared by every request on the server.
 */
export class AppLockGuard {
	/** The privacy cover is up. */
	covered = $state(false);
	#check: AbortController | null = null;
	readonly #sliding: () => boolean;

	/** `sliding`: whether this session's app lock runs its idle clock here. */
	constructor(sliding: () => boolean) {
		this.#sliding = sliding;
	}

	/** Ask the server whether the lock still holds; uncover, or go to /unlock. */
	async check({ supersede = false } = {}): Promise<void> {
		if (!this.#sliding() || document.visibilityState !== 'visible') return;
		if (this.#check) {
			if (!supersede) return;
			this.#check.abort();
		}
		const check = new AbortController();
		this.#check = check;
		const timeout = setTimeout(() => check.abort(), CHECK_TIMEOUT_MS);
		try {
			const res = await fetch(APP_LOCK_KEEPALIVE_PATH, { signal: check.signal });
			if (this.#check !== check) return;
			if (res.status === APP_LOCKED_STATUS) {
				// Carry where the user is HEADED, not where they are. A resume is
				// often the start of a navigation — a tapped notification posts
				// `navigate_to_conversation` into this window as it comes forward —
				// and this goto supersedes it. Reading `location` here sent the
				// user to whatever was on screen before the tap (usually the home
				// page), and after unlocking they landed there, not on the thread.
				const target = navigating.to?.url ?? location;
				// Already on its way to /unlock, or already there (the tap's load hit
				// the server's lock redirect first, which carries the right `from`
				// and unmounts this layout — but not this check, still in flight):
				// leave it alone. Another hop would only nest `from` inside itself.
				if (target.pathname === resolve('unlock')) return;
				const from = encodeURIComponent(target.pathname + target.search);
				await goto(`${resolve('unlock')}?from=${from}`, { replace: true });
			} else if (res.ok) {
				this.covered = false;
			} else if (res.status === 401) {
				// Session gone entirely — let the layout load send us to /login.
				await refreshAll();
			}
		} catch {
			// Offline, unreachable, timed out or superseded: stay covered.
		} finally {
			clearTimeout(timeout);
			if (this.#check === check) this.#check = null;
		}
	}

	/** Cover the page: it is going hidden, or coming back unchecked. */
	cover(): void {
		if (!this.#sliding()) return;
		this.covered = true;
		// A check started before the hide must not uncover the page after it.
		this.#check?.abort();
		this.#check = null;
	}
}
