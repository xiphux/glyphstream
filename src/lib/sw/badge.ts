/**
 * The installed PWA's home-screen icon badge — the count bubble iOS and
 * Android draw on the app icon.
 *
 * NOT the `badge:` option passed to showNotification. That one is
 * Android's monochrome status-bar glyph for the notification itself
 * (`/badge-96.png`) and has nothing to do with the app icon. The two
 * share a name and nothing else.
 *
 * **The notification tray is the state.** Every notification the SW
 * raises is tagged with its conversation id, so `getNotifications()`
 * returns exactly the set of threads holding a completion the user
 * hasn't acknowledged — which is the number the badge wants. Deriving
 * from the tray rather than keeping our own counter means there is no
 * second source of truth to drift out of sync with what the user can
 * see, and nothing to persist across the SW being killed: the tray
 * belongs to the registration and the OS, not to the worker instance,
 * so it survives iOS reclaiming the process.
 *
 * Because notifications are tagged per conversation (with
 * `renotify: true`), a second completion in a thread you haven't looked
 * at yet REPLACES the first rather than stacking. So the count reads as
 * "threads waiting on you", not "messages waiting on you". That's the
 * intended meaning — the badge answers "did something finish?", and a
 * thread that finished twice is still one thread to go look at.
 *
 * Both entry points are best-effort and never throw. A wrong badge is a
 * cosmetic nuisance; it is not worth failing the delete or the push that
 * happened to be the thing updating it.
 */

/**
 * Structural rather than the lib's `NavigatorBadge`, so this module
 * compiles identically in window scope and in ServiceWorker scope
 * (`navigator` is a `WorkerNavigator` there) without either lib's
 * globals having to be in view.
 */
interface BadgeNavigator {
	setAppBadge(contents?: number): Promise<void>;
	clearAppBadge(): Promise<void>;
}

/**
 * The Badging API, or null where it doesn't exist: Firefox, iOS before
 * 16.4, any browser tab that isn't an installed app, and SSR (where
 * there may be no `navigator` at all).
 */
function badgeNavigator(): BadgeNavigator | null {
	const nav = (globalThis as { navigator?: Partial<BadgeNavigator> }).navigator;
	if (typeof nav?.setAppBadge !== 'function' || typeof nav.clearAppBadge !== 'function') {
		return null;
	}
	return nav as BadgeNavigator;
}

/**
 * How many conversations are sitting unacknowledged in the tray, or null
 * when we can't tell — no registration yet (dev builds don't register a
 * SW), no `getNotifications` (it's absent on some older WebKit), or the
 * query threw. Null is deliberately distinct from 0: "I don't know" and
 * "nothing is waiting" lead to opposite decisions below.
 */
async function outstandingCount(
	registration: ServiceWorkerRegistration | undefined,
): Promise<number | null> {
	if (!registration?.getNotifications) return null;
	try {
		return (await registration.getNotifications()).length;
	} catch {
		return null;
	}
}

/**
 * Set the badge after raising a notification. Never clears.
 *
 * We have just put something in the tray, so a count of 0 — or a query
 * we couldn't answer — is wrong, and passing 0 to `setAppBadge` CLEARS
 * the badge rather than displaying a zero. That would turn an
 * unreliable tray query into no badge at all, which is worse than not
 * having tried. The argument-less form shows a plain dot instead: less
 * information, but it still says "something is waiting for you", which
 * is the part that matters.
 */
export async function raiseAppBadge(
	registration: ServiceWorkerRegistration | undefined,
): Promise<void> {
	const nav = badgeNavigator();
	if (!nav) return;
	const count = await outstandingCount(registration);
	try {
		await nav.setAppBadge(count && count > 0 ? count : undefined);
	} catch {
		// Permission revoked, or the platform refused. Nothing to do.
	}
}

/**
 * Re-derive the badge from the tray after something left it — a
 * dismissal, a notification tap, or the app coming back to the
 * foreground. This one DOES clear, since an empty tray is the whole
 * point of calling it.
 *
 * An unknown count (null) is left alone rather than treated as zero: a
 * stale badge is a smaller error than wiping one that is still earned.
 */
export async function syncAppBadge(
	registration: ServiceWorkerRegistration | undefined,
): Promise<void> {
	const nav = badgeNavigator();
	if (!nav) return;
	const count = await outstandingCount(registration);
	if (count === null) return;
	try {
		if (count === 0) await nav.clearAppBadge();
		else await nav.setAppBadge(count);
	} catch {
		// As above — best-effort.
	}
}
