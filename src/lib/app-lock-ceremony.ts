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

/** Bound on the options request — the same reasoning as the layout's lock check. */
const OPTIONS_TIMEOUT_MS = 8_000;

export async function getAppLockAssertion(): Promise<AppLockAssertionResult> {
	// Everything before the prompt can fail on the network — most likely right
	// after a backgrounded app resumes, which is exactly when this runs — and
	// must come back as an error the caller can show. Thrown out of here it
	// would leave the unlock screen on a bare button with nothing said.
	let startAuthentication: typeof import('@simplewebauthn/browser').startAuthentication;
	let optionsJSON: Parameters<typeof startAuthentication>[0]['optionsJSON'];
	try {
		// Dynamic import, as on the login page: the WebAuthn shim stays off the
		// critical path of every route that never runs a ceremony.
		({ startAuthentication } = await import('@simplewebauthn/browser'));
		const optionsRes = await fetch('/api/auth/unlock/options', {
			method: 'POST',
			signal: AbortSignal.timeout(OPTIONS_TIMEOUT_MS),
		});
		if (!optionsRes.ok) return { ok: false, error: await errorMessageFromResponse(optionsRes) };
		optionsJSON = (await optionsRes.json()) as typeof optionsJSON;
	} catch {
		return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
	}
	try {
		return { ok: true, response: await startAuthentication({ optionsJSON }) };
	} catch (e) {
		// NotAllowedError = dismissed, timed out, or (Safari) no user gesture.
		if (e instanceof DOMException && e.name === 'NotAllowedError')
			return { ok: false, error: null };
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
