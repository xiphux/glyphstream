/**
 * Client-side Web Push helpers. Wraps the four browser APIs the
 * subscription flow needs (`navigator.serviceWorker`, `PushManager`,
 * `Notification`, and `matchMedia`) so the settings UI can drive the
 * end-to-end "enable notifications" flow without juggling base64
 * encoding, registration timing, or platform quirks at the call site.
 *
 * iOS Web Push (16.4+) has two non-obvious constraints:
 *  1. The PWA must be installed to the Home Screen — Safari running
 *     in a normal tab can never receive push, even if the user grants
 *     permission. `isIosStandalone()` lets the UI gate the toggle.
 *  2. `Notification.requestPermission()` must run inside a user
 *     gesture. That's why `subscribe()` accepts the public key as an
 *     argument rather than fetching it itself — the fetch can happen
 *     on page load, but the permission request must be triggered
 *     synchronously by a click handler.
 */

import { browser } from '$app/environment';

/**
 * Whether this environment can plausibly subscribe to push. Returns
 * false on server-side calls (SSR), on browsers that don't ship
 * PushManager, and on iOS Safari prior to 16.4.
 */
export function isPushSupported(): boolean {
	return (
		browser && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
	);
}

/**
 * Whether this is iOS Safari without a Home Screen install — iOS only
 * delivers push to installed PWAs, so the toggle should be gated on
 * this and show an "install first" hint when it's true.
 */
export function isIosBeforeInstall(): boolean {
	if (!browser) return false;
	const isIosUa = /iPhone|iPad|iPod/i.test(navigator.userAgent);
	if (!isIosUa) return false;
	const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
	// Older iOS sets a non-standard `navigator.standalone` instead.
	const legacyStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
	return !(standalone || legacyStandalone);
}

export function getPermissionState(): NotificationPermission {
	if (!browser || !('Notification' in window)) return 'default';
	return Notification.permission;
}

export interface PushConfigResponse {
	enabled: boolean;
	vapidPublicKey: string | null;
}

/** Fetch /api/push/config — returns null when the request fails (auth
 *  expired, network error). The UI treats null as "disabled". */
export async function loadPushConfig(): Promise<PushConfigResponse | null> {
	try {
		const res = await fetch('/api/push/config', { credentials: 'same-origin' });
		if (!res.ok) return null;
		return (await res.json()) as PushConfigResponse;
	} catch {
		return null;
	}
}

export type SubscribeResult =
	| { ok: true }
	| { ok: false; reason: 'unsupported' | 'permission_denied' | 'no_registration' | 'network' };

/**
 * Request permission, create a `PushSubscription` against the SW
 * registration, and persist it to the server. Must be called inside a
 * user gesture (click handler) or iOS will silently refuse the
 * permission prompt.
 */
export async function subscribe(vapidPublicKey: string): Promise<SubscribeResult> {
	if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

	if (Notification.permission === 'default') {
		const result = await Notification.requestPermission();
		if (result !== 'granted') return { ok: false, reason: 'permission_denied' };
	} else if (Notification.permission !== 'granted') {
		return { ok: false, reason: 'permission_denied' };
	}

	const reg = await navigator.serviceWorker.ready.catch(() => null);
	if (!reg) return { ok: false, reason: 'no_registration' };

	const existing = await reg.pushManager.getSubscription();
	const subscription =
		existing ??
		(await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
		}));

	if (!(await registerWithServer(subscription))) return { ok: false, reason: 'network' };
	return { ok: true };
}

/**
 * POST a subscription to the server (upsert keyed on endpoint). Shared by the
 * settings toggle's `subscribe()` and the on-load `reconcileSubscription()`.
 * Returns false on a non-OK response or network error; the callers decide how
 * to surface that (the toggle reports `network`, reconcile silently retries on
 * the next load).
 */
async function registerWithServer(subscription: PushSubscription): Promise<boolean> {
	const body = subscription.toJSON();
	try {
		const res = await fetch('/api/push/subscribe', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				endpoint: body.endpoint,
				keys: body.keys,
				userAgent: navigator.userAgent,
			}),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * What `reconcileSubscription` should do given the observable state. Pure so the
 * decision matrix is unit-testable without stubbing the four browser APIs (same
 * split as `sw-arbiter`'s `pickAction`).
 *
 *  - `skip`              — not opted in / can't or shouldn't act. Never prompts.
 *  - `subscribe-new`     — opted in but no browser subscription exists (it was
 *                          evicted by the OS, or the server row was pruned and
 *                          the browser sub lapsed): create one + register it.
 *  - `resubscribe`       — a subscription exists but is bound to a DIFFERENT
 *                          VAPID key than the server now advertises (operator
 *                          rotated keys): drop it, then create + register a new
 *                          one against the current key.
 *  - `register-existing` — a valid subscription exists; (re-)POST it to heal a
 *                          server row that was pruned (404/410) while the
 *                          browser kept its subscription.
 */
export type ReconcileAction = 'skip' | 'subscribe-new' | 'resubscribe' | 'register-existing';

export function decideReconcile(input: {
	enabled: boolean;
	pushSupported: boolean;
	permission: NotificationPermission;
	serverConfigured: boolean;
	hasSubscription: boolean;
	keyMatches: boolean;
}): ReconcileAction {
	// Only ever act for a user who has opted in AND already granted permission —
	// reconciliation must never surface a permission prompt on load.
	if (!input.enabled || !input.pushSupported || input.permission !== 'granted') return 'skip';
	// Server push disabled/unconfigured — nothing to register against.
	if (!input.serverConfigured) return 'skip';
	if (!input.hasSubscription) return 'subscribe-new';
	if (!input.keyMatches) return 'resubscribe';
	return 'register-existing';
}

/**
 * Reconcile the push subscription on app load. The settings toggle is the only
 * place that *creates* a subscription, so once the browser or push service
 * drops it (iOS eviction, PWA re-add, a 404/410 server-side prune), it stays
 * dead: the pref still reads "on", permission still reads "granted", the toggle
 * still shows ON — but there's no endpoint to send to, silently. Called from the
 * (app) layout's onMount, this re-establishes the subscription so any one-time
 * invalidation self-heals on the next visit instead of staying broken until the
 * user manually toggles off/on. Fire-and-forget; never throws.
 */
export async function reconcileSubscription(enabled: boolean): Promise<void> {
	if (!enabled || !isPushSupported() || Notification.permission !== 'granted') return;

	const cfg = await loadPushConfig();
	if (!cfg?.enabled || !cfg.vapidPublicKey) return;

	const reg = await navigator.serviceWorker.ready.catch(() => null);
	if (!reg) return;

	const existing = await reg.pushManager.getSubscription();
	const action = decideReconcile({
		enabled,
		pushSupported: true,
		permission: Notification.permission,
		serverConfigured: true,
		hasSubscription: existing !== null,
		keyMatches: existing !== null && subscriptionMatchesKey(existing, cfg.vapidPublicKey),
	});
	if (action === 'skip') return;

	let subscription = existing;
	if (action === 'resubscribe') {
		await subscription?.unsubscribe().catch(() => {});
		subscription = null;
	}
	if (!subscription) {
		try {
			subscription = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
			});
		} catch {
			// Browser/push service refused (e.g. key mismatch mid-rotation) —
			// nothing more we can do silently; the next load reconciles again.
			return;
		}
	}
	await registerWithServer(subscription);
}

/**
 * Whether an existing subscription was created against the VAPID public key the
 * server currently advertises. A mismatch means the operator rotated keys and
 * the subscription can never receive our sends. When the browser doesn't expose
 * the key (`options.applicationServerKey` is null), assume a match rather than
 * force a needless churn.
 */
function subscriptionMatchesKey(subscription: PushSubscription, vapidPublicKey: string): boolean {
	const raw = subscription.options?.applicationServerKey;
	if (!raw) return true;
	const have = new Uint8Array(raw);
	const want = urlBase64ToUint8Array(vapidPublicKey);
	if (have.length !== want.length) return false;
	for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
	return true;
}

/**
 * Delete the subscription server-side, then call `subscription.unsubscribe()`
 * to revoke it in the browser. Order matters: doing the browser call
 * first would leave a server row pointing at a dead endpoint until the
 * push service eventually returns 410 and the notify pipeline cleaned it
 * up.
 */
export async function unsubscribe(): Promise<void> {
	if (!isPushSupported()) return;
	const reg = await navigator.serviceWorker.ready.catch(() => null);
	if (!reg) return;
	const subscription = await reg.pushManager.getSubscription();
	if (!subscription) return;

	try {
		await fetch('/api/push/subscribe', {
			method: 'DELETE',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ endpoint: subscription.endpoint }),
		});
	} catch {
		// Swallow — the browser unsubscribe below still happens, and a
		// stale row will be cleaned up by the notify pipeline on the
		// next 410 from the push service.
	}
	await subscription.unsubscribe().catch(() => {});
}

/**
 * The applicationServerKey VAPID public key arrives as URL-safe
 * base64; PushManager.subscribe needs it as a Uint8Array. Tiny
 * conversion, kept inline so the module has no dependencies.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
	const padding = '='.repeat((4 - (base64.length % 4)) % 4);
	const padded = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(padded);
	// Allocate an explicit ArrayBuffer (not the default ArrayBufferLike,
	// which can include SharedArrayBuffer) so the result satisfies
	// PushManager.subscribe's BufferSource parameter type strictly.
	const buffer = new ArrayBuffer(raw.length);
	const out = new Uint8Array(buffer);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}
