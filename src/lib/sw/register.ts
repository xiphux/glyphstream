/**
 * Service-worker registration with a user-driven update prompt.
 *
 * A port of vite-plugin-pwa's `registerSW` in its `registerType: 'prompt'`
 * mode, which this replaced when the plugin went: the worker is built by
 * SvelteKit, and this was the only part of the plugin still doing anything at
 * runtime. Kept to the same event semantics, because the root layout's update
 * flow was built and debugged against them — with one deliberate exception, when
 * a takeover reloads the page (see `promptRaised`).
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
	/**
	 * A new worker is waiting to take over. Resolves whether the user was
	 * actually offered the update: the caller may decline to prompt (a waiting
	 * worker on the build the page already runs), and only an offer arms the
	 * reload on takeover.
	 */
	onNeedRefresh: () => Promise<boolean>;
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

	// Reload on any takeover that follows a prompt this page actually SHOWED —
	// whichever tab's Refresh caused it. A worker activated from another tab
	// claims this one too, and staying put would leave this page on the old
	// bundle under the new worker, with a banner whose Refresh has nothing left
	// to activate. Two takeovers must NOT reload, and neither shows a prompt: the
	// first install (`clients.claim()` on activate — a needless second load), and
	// an update this page declined to offer because it already runs that build,
	// which is every page opened after a deploy, while an older tab still waits on
	// its Refresh. Reloading those would cut off a stream or a draft unannounced.
	//
	// Deliberately not the plugin's test, `event.isUpdate`: workbox-window fixes
	// that at registration, from whether anything controlled the page THEN. A
	// page first opened before any worker installed keeps `isUpdate: false` for
	// its whole life, so a Refresh tapped later in that same session activated
	// the new worker and never reloaded. (Found verifying this port; the plugin
	// had the same gap.)
	let promptRaised = false;
	const prompt = () => {
		void onNeedRefresh().then(
			(shown) => {
				if (shown) promptRaised = true;
			},
			() => {},
		);
	};
	wb.addEventListener('controlling', () => {
		if (promptRaised) window.location.reload();
	});

	// The usual path: this page registered, and a newer worker installed behind
	// the one controlling it.
	wb.addEventListener('waiting', prompt);
	// A worker installed by ANOTHER tab or window. workbox-window reports that as
	// `isExternal` with `isUpdate` unset, and it waits all the same.
	wb.addEventListener('installed', (event) => {
		if (event.isUpdate === undefined && event.isExternal) prompt();
	});

	// `immediate`: register now, not at window `load`. The layout calls this from
	// onMount, which already runs after the page has loaded.
	let registration: ServiceWorkerRegistration | undefined;
	void wb.register({ immediate: true }).then(
		(r) => {
			registration = r;
			onRegistered(r);
		},
		// Nothing on the page depends on a worker, so a failure just leaves the app
		// uncached — but it fails silently otherwise, including a worker that throws
		// as it loads (a build that stopped forwarding `define`), so say so here.
		(err: unknown) => console.warn('Service worker registration failed', err),
	);

	return () => {
		// Nothing waiting means the worker this prompt was for has already taken
		// over — or gone redundant — and `messageSkipWaiting` would post to no one,
		// leaving the click dead. A reload still lands the page on what's current.
		if (!registration?.waiting) {
			window.location.reload();
			return;
		}
		wb.messageSkipWaiting();
	};
}
