/**
 * Service-worker registration with a user-driven update prompt.
 *
 * A port of vite-plugin-pwa's `registerSW` in its `registerType: 'prompt'`
 * mode, which this replaced when the plugin went: the worker is built by
 * SvelteKit, and this was the only part of the plugin still doing anything at
 * runtime. Kept to the same event semantics, because the root layout's update
 * flow was built and debugged against them — with one deliberate exception, the
 * reload after Refresh (see `activationRequested`).
 *
 * 'prompt', not auto-update: a new worker downloads in the background and
 * WAITS until the user opts in through UpdateBanner. Swapping it silently on
 * the next navigation can yank an in-flight stream or an unsaved edit out from
 * under the user. That is also why the worker never calls skipWaiting() on
 * install — see the note above its message listener.
 *
 * Imported on demand from the root layout, so workbox-window stays out of the
 * initial load.
 */
import { Workbox } from 'workbox-window';

interface RegisterOptions {
	/** A new worker is waiting to take over. */
	onNeedRefresh: () => void;
	/** Registration succeeded; the layout hangs its own update checks off it. */
	onRegistered: (registration: ServiceWorkerRegistration | undefined) => void;
}

/**
 * Register /service-worker.js. Returns the function that activates a waiting
 * worker; the page reloads once it takes control.
 */
export function registerServiceWorker({
	onNeedRefresh,
	onRegistered,
}: RegisterOptions): () => void {
	const wb = new Workbox('/service-worker.js', { scope: '/' });

	// Reload on the takeover the user ASKED for, and only that one. The first
	// install claims the page too (`clients.claim()` on activate), and reloading
	// for that would be a needless second load.
	//
	// Deliberately not the plugin's test, `event.isUpdate`: workbox-window fixes
	// that at registration, from whether anything controlled the page THEN. A
	// page first opened before any worker installed keeps `isUpdate: false` for
	// its whole life, so a Refresh tapped later in that same session activated
	// the new worker and never reloaded — the page sat on the old bundle under
	// the new worker, with the banner gone. (Found verifying this port; the
	// plugin had the same gap.)
	let activationRequested = false;
	wb.addEventListener('controlling', () => {
		if (activationRequested) window.location.reload();
	});

	// The usual path: this page registered, and a newer worker installed behind
	// the one controlling it.
	wb.addEventListener('waiting', onNeedRefresh);
	// A worker installed by ANOTHER tab or window. workbox-window reports that as
	// `isExternal` with `isUpdate` unset, and it waits all the same.
	wb.addEventListener('installed', (event) => {
		if (event.isUpdate === undefined && event.isExternal) onNeedRefresh();
	});

	// `immediate`: register now, not at window `load`. The layout calls this from
	// onMount, which already runs after the page has loaded.
	void wb.register({ immediate: true }).then(onRegistered, () => {});

	return () => {
		activationRequested = true;
		wb.messageSkipWaiting();
	};
}
