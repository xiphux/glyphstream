/**
 * The client half of the app-lock passkey ceremony, shared by the unlock screen
 * and the "turn on app lock" flow in Settings → Security (which proves a
 * passkey works before switching the lock on). Fetches options restricted to
 * the signed-in account's passkeys and runs the OS prompt — Face ID on iOS.
 */
import { errorMessageFromResponse } from '$lib/fetch-error';

export type AppLockAssertionResult =
	| { ok: true; response: unknown }
	/** `error: null` = the user dismissed the prompt; nothing to show. */
	| { ok: false; error: string | null };

export async function getAppLockAssertion(): Promise<AppLockAssertionResult> {
	// Dynamic import, as on the login page: the WebAuthn shim stays off the
	// critical path of every route that never runs a ceremony.
	const { startAuthentication } = await import('@simplewebauthn/browser');
	const optionsRes = await fetch('/api/auth/unlock/options', { method: 'POST' });
	if (!optionsRes.ok) return { ok: false, error: await errorMessageFromResponse(optionsRes) };
	const optionsJSON = (await optionsRes.json()) as Parameters<
		typeof startAuthentication
	>[0]['optionsJSON'];
	try {
		return { ok: true, response: await startAuthentication({ optionsJSON }) };
	} catch (e) {
		// NotAllowedError = dismissed, timed out, or (Safari) no user gesture.
		if (e instanceof DOMException && e.name === 'NotAllowedError')
			return { ok: false, error: null };
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
