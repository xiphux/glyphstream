/**
 * Thin glue around @simplewebauthn/server for the passkey login flow.
 *
 * RP identity is derived from `publicBaseUrl()` (env-driven), not from
 * request headers — a flapping `Host` from a misconfigured reverse proxy
 * would otherwise silently invalidate every registered credential.
 * Changing EXTERNAL_BASE_URL after passkeys exist is a deliberate
 * operational hazard (documented in the README).
 *
 * All public functions are async; SimpleWebAuthn's API is promise-based
 * even when the work is synchronous.
 */

import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type VerifiedAuthenticationResponse,
	type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
	WebAuthnCredential,
} from '@simplewebauthn/server';
import { type Cookies, error } from '@sveltejs/kit';
import { cookiesSecure, publicBaseUrl } from '../env';
import type { SessionUser } from './session';
import {
	pickKnownTransports,
	updateCredentialCounterAndLastUsed,
	type AuthenticatorTransport,
	type PasskeyCredentialRow,
	type PasskeyDeviceType,
} from '../db/queries/passkey';

/** Short-lived httpOnly cookies that carry the challenge between the
 *  "options" and "verify" halves of each ceremony. Mirrors the shape of
 *  the existing GitHub OAuth state cookie. */
const REGISTRATION_COOKIE = 'glyphstream_passkey_reg_challenge';
const LOGIN_COOKIE = 'glyphstream_passkey_login_challenge';
const UNLOCK_COOKIE = 'glyphstream_passkey_unlock_challenge';
const CHALLENGE_TTL_SECONDS = 300;

export const RP_NAME = 'GlyphStream';

let cachedRpId: string | null = null;
let cachedExpectedOrigin: string | null = null;

/**
 * WebAuthn `rp.id` is the bare registrable domain (no scheme, no port).
 * Derived from EXTERNAL_BASE_URL — see file header.
 */
export function getRpId(): string {
	if (!cachedRpId) {
		cachedRpId = new URL(publicBaseUrl()).hostname;
	}
	return cachedRpId;
}

/**
 * `expectedOrigin` is the full scheme + host + port, exactly as the
 * browser will report it in `clientDataJSON.origin`.
 */
export function getExpectedOrigin(): string {
	if (!cachedExpectedOrigin) {
		cachedExpectedOrigin = publicBaseUrl();
	}
	return cachedExpectedOrigin;
}

/** Test-only: drop cached RP ID + origin so a test can swap publicBaseUrl(). */
export function resetRpCache(): void {
	cachedRpId = null;
	cachedExpectedOrigin = null;
}

/**
 * Build registration options for an authenticated user. The user's
 * existing credentials are passed in `excludeCredentials` so the
 * browser refuses to re-bind the same authenticator twice. `userID` is
 * the UTF-8 bytes of `users.id` (UUID) so the authenticator stores it
 * verbatim and returns it as `userHandle` on every login — letting us
 * cross-check the credential's owner during usernameless flows.
 */
export async function generateRegistrationOptionsForUser(
	user: SessionUser,
	existing: PasskeyCredentialRow[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	// WebAuthn `userName` is "a human-palatable stable identifier";
	// `userDisplayName` is the friendly label. Email is the closest
	// thing the operator typed in; fall back to display name then id
	// so the password manager always has *something* recognizable.
	const userName = user.email ?? user.displayName ?? user.id;
	const userDisplayName = user.displayName ?? user.email ?? 'Operator';
	return await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: getRpId(),
		userName,
		userDisplayName,
		userID: new TextEncoder().encode(user.id),
		attestationType: 'none',
		authenticatorSelection: {
			residentKey: 'preferred',
			userVerification: 'required',
		},
		excludeCredentials: existing.map((c) => ({
			id: c.id,
			transports: c.transports ?? undefined,
		})),
		timeout: 60_000,
	});
}

export async function verifyRegistration(
	response: RegistrationResponseJSON,
	expectedChallenge: string,
): Promise<VerifiedRegistrationResponse> {
	return await verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: getExpectedOrigin(),
		expectedRPID: getRpId(),
		requireUserVerification: true,
	});
}

/** The verified credential + parsed body returned by a registration ceremony. */
export interface RegistrationCeremonyResult {
	credential: NonNullable<VerifiedRegistrationResponse['registrationInfo']>['credential'];
	backedUp: boolean;
	deviceType: PasskeyDeviceType;
	transports: AuthenticatorTransport[] | null;
	/** The raw parsed request body, for callers that read extra fields (e.g. `name`). */
	body: { response: RegistrationResponseJSON; name?: unknown };
}

/**
 * Run the shared half of every passkey *registration* verify endpoint: read +
 * clear the challenge cookie, parse and validate the request body, verify the
 * registration response, and project the credential + transports. Throws the
 * appropriate SvelteKit `error()` (400) on any failure.
 *
 * The three callers (first-run setup, invited /join, authed add-a-passkey) wrap
 * this with their own flow-specific gate (setupGate / invite / requireUser) and
 * persistence (createInitialUser+insertCredential / finalizePasskeyJoin /
 * insertCredential). Centralizing the ceremony is the anti-drift measure — a
 * tightening of the WebAuthn verification lands in one place, not three. Callers
 * that read the challenge alongside a carry cookie should read+clear the carry
 * BEFORE calling this (it throws on a missing challenge first).
 */
export async function verifyRegistrationCeremony(
	cookies: Cookies,
	request: Request,
): Promise<RegistrationCeremonyResult> {
	const challenge = readRegistrationChallengeCookie(cookies);
	clearRegistrationChallengeCookie(cookies);
	if (!challenge) error(400, 'Missing or expired challenge');

	let body: { response?: RegistrationResponseJSON; name?: unknown };
	try {
		body = (await request.json()) as { response?: RegistrationResponseJSON; name?: unknown };
	} catch {
		error(400, 'Malformed JSON body');
	}
	if (!body.response || typeof body.response !== 'object') {
		error(400, 'Missing registration response');
	}

	let verification: VerifiedRegistrationResponse;
	try {
		verification = await verifyRegistration(body.response, challenge);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'Verification failed');
	}
	if (!verification.verified || !verification.registrationInfo) {
		error(400, 'Passkey verification failed');
	}

	const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
	return {
		credential,
		backedUp: credentialBackedUp,
		deviceType: credentialDeviceType,
		transports: pickKnownTransports(body.response.response?.transports),
		body: { response: body.response, name: body.name },
	};
}

/**
 * Build authentication options for a usernameless / discoverable-
 * credential login. `allowCredentials: []` tells the browser to pick
 * from any resident credential it has for this RP ID — the user picks
 * the account themselves at the OS prompt, so the login page never asks
 * for a username (and never enumerates accounts).
 */
export async function generateAuthenticationOptionsAny(): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return await generateAuthenticationOptions({
		rpID: getRpId(),
		allowCredentials: [],
		userVerification: 'required',
		timeout: 60_000,
	});
}

export async function verifyAuthentication(
	response: AuthenticationResponseJSON,
	params: { expectedChallenge: string; credential: WebAuthnCredential },
): Promise<VerifiedAuthenticationResponse> {
	return await verifyAuthenticationResponse({
		response,
		expectedChallenge: params.expectedChallenge,
		expectedOrigin: getExpectedOrigin(),
		expectedRPID: getRpId(),
		credential: params.credential,
		requireUserVerification: true,
	});
}

/**
 * Build authentication options restricted to one user's own credentials — the
 * app-lock unlock (and enable) ceremony. Unlike login, the account is already
 * known, and ANY passkey on the device is not good enough: a second account's
 * credential on a shared phone must not unlock this user's session. Listing the
 * credentials makes the OS offer only those; `verifyUnlockAssertion` enforces it.
 */
export async function generateAuthenticationOptionsForUser(
	credentials: PasskeyCredentialRow[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return await generateAuthenticationOptions({
		rpID: getRpId(),
		allowCredentials: credentials.map((c) => ({
			id: c.id,
			transports: c.transports ?? undefined,
		})),
		userVerification: 'required',
		timeout: 60_000,
	});
}

/**
 * Verify a signed assertion against a credential row already resolved (and
 * ownership-checked) by the caller, then advance its counter. Throws a 401
 * `error()` on any failure. Shared by passkey login and the app-lock unlock so
 * the userHandle cross-check and clone guard can't drift between them.
 *
 * Counter-clone guard: WebAuthn's `newCounter` should monotonically increase
 * for hardware-counted authenticators. If `stored > 0 && new <= stored`, the
 * credential may have been cloned and we refuse without updating. The
 * `stored > 0` half is intentional — Apple iCloud Keychain (and some other
 * platform authenticators) always returns 0, so a naive `new <= stored` check
 * would lock out every Mac and iPhone user on their second use.
 *
 * userHandle cross-check: the authenticator returns the `userID` we stashed
 * during registration (UTF-8 bytes of users.id). If it disagrees with the
 * credential row's user_id, something is deeply wrong — refuse rather than
 * guess which side to trust.
 */
export async function verifyStoredCredentialAssertion(
	response: AuthenticationResponseJSON,
	expectedChallenge: string,
	credential: PasskeyCredentialRow,
	logTag: string,
): Promise<void> {
	const handleUserId = decodeUserHandle(response.response?.userHandle ?? null);
	if (handleUserId && handleUserId !== credential.userId) {
		console.warn(
			`[${logTag}] userHandle mismatch on credential ${credential.id}: ${handleUserId} vs row ${credential.userId}`,
		);
		error(401, 'Credential identity mismatch');
	}

	let verification: VerifiedAuthenticationResponse;
	try {
		verification = await verifyAuthentication(response, {
			expectedChallenge,
			credential: {
				id: credential.id,
				// `.slice()` produces a `Uint8Array<ArrayBuffer>` (the exact
				// shape SimpleWebAuthn's `Uint8Array_` aliases). Our row type
				// is plain `Uint8Array` to stay consumer-agnostic.
				publicKey: credential.publicKey.slice(),
				counter: credential.counter,
				transports: credential.transports ?? undefined,
			},
		});
	} catch (e) {
		error(401, e instanceof Error ? e.message : 'Verification failed');
	}
	if (!verification.verified) error(401, 'Passkey verification failed');

	const newCounter = verification.authenticationInfo.newCounter;
	if (credential.counter > 0 && newCounter <= credential.counter) {
		console.warn(
			`[${logTag}] Counter regression on credential ${credential.id}: stored=${credential.counter} new=${newCounter}. Possible clone.`,
		);
		error(401, 'Possible cloned credential');
	}
	updateCredentialCounterAndLastUsed(credential.id, newCounter, Date.now());
}

/**
 * Decode the `userHandle` an authenticator returns on login back into
 * the UUID string we set as `userID` during registration. Used as a
 * belt-and-suspenders cross-check that the credential row's `userId`
 * matches what the authenticator recorded — defense against the
 * pathological case (DB corruption, environment mixing).
 *
 * Returns null if the field is missing or doesn't round-trip to a
 * plausible string.
 */
export function decodeUserHandle(userHandle: string | undefined | null): string | null {
	if (!userHandle) return null;
	try {
		const bytes = Buffer.from(userHandle, 'base64url');
		const decoded = bytes.toString('utf8');
		// Must be a non-empty printable string. We don't validate the UUID
		// shape here — the caller compares it to a known-good row id.
		return decoded.length > 0 ? decoded : null;
	} catch {
		return null;
	}
}

// --- challenge cookies ---------------------------------------------------

function writeChallengeCookie(cookies: Cookies, name: string, challenge: string): void {
	cookies.set(name, challenge, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: cookiesSecure(),
		maxAge: CHALLENGE_TTL_SECONDS,
	});
}

export function setRegistrationChallengeCookie(cookies: Cookies, challenge: string): void {
	writeChallengeCookie(cookies, REGISTRATION_COOKIE, challenge);
}

export function readRegistrationChallengeCookie(cookies: Cookies): string | undefined {
	return cookies.get(REGISTRATION_COOKIE);
}

export function clearRegistrationChallengeCookie(cookies: Cookies): void {
	cookies.delete(REGISTRATION_COOKIE, { path: '/' });
}

export function setLoginChallengeCookie(cookies: Cookies, challenge: string): void {
	writeChallengeCookie(cookies, LOGIN_COOKIE, challenge);
}

export function readLoginChallengeCookie(cookies: Cookies): string | undefined {
	return cookies.get(LOGIN_COOKIE);
}

export function clearLoginChallengeCookie(cookies: Cookies): void {
	cookies.delete(LOGIN_COOKIE, { path: '/' });
}

export function setUnlockChallengeCookie(cookies: Cookies, challenge: string): void {
	writeChallengeCookie(cookies, UNLOCK_COOKIE, challenge);
}

export function readUnlockChallengeCookie(cookies: Cookies): string | undefined {
	return cookies.get(UNLOCK_COOKIE);
}

export function clearUnlockChallengeCookie(cookies: Cookies): void {
	cookies.delete(UNLOCK_COOKIE, { path: '/' });
}
