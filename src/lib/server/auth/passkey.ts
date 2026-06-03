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
	AuthenticatorTransportFuture,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
	WebAuthnCredential,
} from '@simplewebauthn/server';
import type { Cookies } from '@sveltejs/kit';
import { publicBaseUrl } from '../env';
import type { SessionUser } from './session';
import type { PasskeyCredentialRow } from '../db/queries/passkey';

/** Short-lived httpOnly cookies that carry the challenge between the
 *  "options" and "verify" halves of each ceremony. Mirrors the shape of
 *  the existing GitHub OAuth state cookie. */
const REGISTRATION_COOKIE = 'glyphstream_passkey_reg_challenge';
const LOGIN_COOKIE = 'glyphstream_passkey_login_challenge';
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
	return await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: getRpId(),
		userName: user.githubUsername,
		userDisplayName: user.displayName ?? user.githubUsername,
		userID: new TextEncoder().encode(user.id),
		attestationType: 'none',
		authenticatorSelection: {
			residentKey: 'preferred',
			userVerification: 'required',
		},
		excludeCredentials: existing.map((c) => ({
			id: c.id,
			transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
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
		secure: process.env.NODE_ENV === 'production',
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
