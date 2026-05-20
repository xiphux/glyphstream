/**
 * Web Push transport. Lazy VAPID initialization so the module is safe
 * to import from anywhere — the `web-push` package isn't actually
 * configured until the first `sendPushNotification` call, and if the
 * `[notifications]` section is absent from config.toml the call is a
 * no-op rather than a crash. That keeps a clone with no VAPID setup
 * bootable; the UI surfaces a hint instead.
 *
 * The web-push package is server-only (Node crypto + libcurl); never
 * import this from client code.
 */

import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import { loadNotificationsConfig, type LoadedNotificationsConfig } from '../endpoints/config';

let initialized = false;
let loadedConfig: LoadedNotificationsConfig | null = null;
let initFailureLogged = false;

/**
 * Resolve + cache the notifications config + push library state. Idempotent:
 * subsequent calls reuse the cache. Returns null when push is disabled
 * (no `[notifications]` block); callers should short-circuit.
 */
function init(): LoadedNotificationsConfig | null {
	if (initialized) return loadedConfig;
	initialized = true;
	try {
		loadedConfig = loadNotificationsConfig();
	} catch (e) {
		if (!initFailureLogged) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn('[push] notifications config invalid; push disabled:', msg);
			initFailureLogged = true;
		}
		loadedConfig = null;
	}
	if (loadedConfig) {
		webpush.setVapidDetails(
			loadedConfig.vapidSubject,
			loadedConfig.vapidPublic,
			loadedConfig.vapidPrivate
		);
	}
	return loadedConfig;
}

/** Reset internal state (test-only). */
export function _resetWebPushForTest(): void {
	initialized = false;
	loadedConfig = null;
	initFailureLogged = false;
}

/**
 * Returns the VAPID public key when push is enabled, else null. The
 * client needs this to call `pushManager.subscribe({ applicationServerKey })`.
 * Exposed via /api/push/config so the UI can fetch it on demand and
 * surface a permission-disabled state when null.
 */
export function getVapidPublicKey(): string | null {
	return init()?.vapidPublic ?? null;
}

export interface PushSendResult {
	ok: boolean;
	/** HTTP status from the push service when ok is false. 404/410 mean
	 *  the subscription is gone and should be deleted. */
	statusCode?: number;
}

/**
 * Send one encrypted push payload to one subscription. Errors are
 * caught and surfaced as `{ ok: false, statusCode }` so callers can
 * decide whether to retry, log, or delete the subscription — never
 * throws.
 */
export async function sendPushNotification(
	subscription: WebPushSubscription,
	payload: string
): Promise<PushSendResult> {
	if (!init()) return { ok: false };
	try {
		await webpush.sendNotification(subscription, payload, { TTL: 60 });
		return { ok: true };
	} catch (e) {
		// web-push throws a WebPushError with statusCode on HTTP failures;
		// other errors (DNS, libcurl) come through as plain Errors.
		const statusCode =
			typeof e === 'object' && e !== null && 'statusCode' in e
				? Number((e as { statusCode: unknown }).statusCode)
				: undefined;
		return { ok: false, statusCode };
	}
}

export type { WebPushSubscription };
