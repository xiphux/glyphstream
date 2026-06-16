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
import { requireUser } from '$lib/server/auth/guard';
import { verifyRegistrationCeremony } from '$lib/server/auth/passkey';
import { type PasskeySummary, insertCredential } from '$lib/server/db/queries/passkey';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

const MAX_NAME_LENGTH = 60;

function sanitizeName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
	return trimmed.length > 0 ? trimmed : null;
}

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');
	requireUser(locals);

	const { credential, backedUp, deviceType, transports, body } = await verifyRegistrationCeremony(
		cookies,
		request,
	);

	// Name is captured pre-ceremony in the UI (the WebAuthn prompt doesn't carry
	// it); trim + length-cap server-side so a stray client-only check can't bypass
	// it. Transports come from the browser's response.transports (the helper
	// already filtered them) so the login picker can surface relevant authenticators.
	const name = sanitizeName(body.name);

	try {
		insertCredential({
			id: credential.id,
			userId: locals.user.id,
			publicKey: credential.publicKey,
			counter: credential.counter,
			transports,
			backedUp,
			deviceType,
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
		backedUp,
		deviceType,
		createdAt: Date.now(),
		lastUsedAt: null,
	};
	return json(summary, { status: 201 });
};
