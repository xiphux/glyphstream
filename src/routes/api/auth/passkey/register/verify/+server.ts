/**
 * POST /api/auth/passkey/register/verify — finish a passkey registration
 * ceremony. Reads the challenge cookie set by `register/options`,
 * verifies the response with SimpleWebAuthn, and persists the new
 * credential against the calling user.
 *
 * Body: `{ response: RegistrationResponseJSON, name?: string | null }`.
 * The name is captured pre-ceremony in the UI (the browser's WebAuthn
 * prompt doesn't carry it) and is trimmed + length-capped server-side
 * so a stray client-only check can't bypass it.
 */
import { error, json } from '@sveltejs/kit';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { requireUser } from '$lib/server/auth/guard';
import {
	clearRegistrationChallengeCookie,
	readRegistrationChallengeCookie,
	verifyRegistration,
} from '$lib/server/auth/passkey';
import {
	type AuthenticatorTransport,
	type PasskeySummary,
	insertCredential,
} from '$lib/server/db/queries/passkey';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

const MAX_NAME_LENGTH = 60;
const VALID_TRANSPORTS: ReadonlySet<AuthenticatorTransport> = new Set([
	'usb',
	'ble',
	'nfc',
	'internal',
	'hybrid',
]);

function sanitizeName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
	return trimmed.length > 0 ? trimmed : null;
}

function pickKnownTransports(raw: unknown): AuthenticatorTransport[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: AuthenticatorTransport[] = [];
	for (const t of raw) {
		if (typeof t === 'string' && VALID_TRANSPORTS.has(t as AuthenticatorTransport)) {
			out.push(t as AuthenticatorTransport);
		}
	}
	return out.length > 0 ? out : null;
}

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');
	requireUser(locals);

	const challenge = readRegistrationChallengeCookie(cookies);
	clearRegistrationChallengeCookie(cookies);
	if (!challenge) throw error(400, 'Missing or expired registration challenge');

	let body: { response?: RegistrationResponseJSON; name?: unknown };
	try {
		body = (await request.json()) as { response?: RegistrationResponseJSON; name?: unknown };
	} catch {
		throw error(400, 'Malformed JSON body');
	}
	if (!body.response || typeof body.response !== 'object') {
		throw error(400, 'Missing registration response');
	}

	let verification;
	try {
		verification = await verifyRegistration(body.response, challenge);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Verification failed';
		throw error(400, message);
	}
	if (!verification.verified || !verification.registrationInfo) {
		throw error(400, 'Passkey verification failed');
	}

	const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;

	const name = sanitizeName(body.name);
	// The browser's RegistrationResponseJSON.response.transports is the
	// authoritative source of transport hints — passing them back during
	// login lets the picker UI surface only the relevant authenticators.
	const transports = pickKnownTransports(body.response.response?.transports);

	try {
		insertCredential({
			id: credential.id,
			userId: locals.user.id,
			publicKey: credential.publicKey,
			counter: credential.counter,
			transports,
			backedUp: credentialBackedUp,
			deviceType: credentialDeviceType,
			name,
		});
	} catch (e) {
		// UNIQUE on credential.id — almost impossible since excludeCredentials
		// is built from this user's existing rows, but a parallel tab race
		// (or a credential id collision across users, which the spec says
		// shouldn't happen but we shouldn't assume) lands here.
		const message = e instanceof Error ? e.message : String(e);
		if (/UNIQUE|PRIMARY KEY/i.test(message)) {
			throw error(409, 'This credential is already registered');
		}
		throw e;
	}

	const summary: PasskeySummary = {
		id: credential.id,
		name,
		backedUp: credentialBackedUp,
		deviceType: credentialDeviceType,
		createdAt: Date.now(),
		lastUsedAt: null,
	};
	return json(summary, { status: 201 });
};
