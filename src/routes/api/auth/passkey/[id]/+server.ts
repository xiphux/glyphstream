/**
 * DELETE /api/auth/passkey/:id — remove a passkey credential.
 * PATCH /api/auth/passkey/:id — rename a passkey credential.
 *
 * Both endpoints scope every mutation by user_id at the query layer, so
 * a fabricated id or another user's id surfaces as a 404, not a touched
 * foreign row.
 *
 * Last-method guard on DELETE: a user must always have ≥1 viable login
 * method. Refuse the delete with a 409 when it would leave the user with
 * zero sign-in methods — counting their ACTUAL remaining bindings (other
 * passkeys + OAuth accounts), not a global feature flag. GITHUB_LOGIN_ENABLED
 * being on does not mean this user has a GitHub binding to fall back to, so a
 * passkey-only account (the normal result of the passkey invite flow) must not
 * be allowed to delete its sole credential. Mirrors the OAuth-unlink sibling.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import {
	deleteCredential,
	listCredentialSummariesForUser,
	renameCredential,
} from '$lib/server/db/queries/passkey';
import { countOAuthAccountsForUser } from '$lib/server/db/queries/oauth-accounts';
import type { RequestHandler } from './$types';

const MAX_NAME_LENGTH = 60;

function sanitizeName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
	return trimmed.length > 0 ? trimmed : null;
}

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	// Check the credential exists (and belongs to this user) BEFORE the
	// last-method math, so a fabricated/foreign id surfaces as 404 rather than a
	// misleading 409.
	const passkeys = listCredentialSummariesForUser(locals.user.id);
	if (!passkeys.some((p) => p.id === params.id)) throw error(404, 'Passkey not found');

	// `passkeys.length - 1` is the passkey count after the impending delete.
	const remainingMethods = countOAuthAccountsForUser(locals.user.id) + (passkeys.length - 1);
	if (remainingMethods <= 0) {
		throw error(
			409,
			"Can't delete your last sign-in method. Add another passkey or link a provider first.",
		);
	}
	deleteCredential(locals.user.id, params.id);
	return new Response(null, { status: 204 });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	let body: { name?: unknown };
	try {
		body = (await request.json()) as { name?: unknown };
	} catch {
		throw error(400, 'Malformed JSON body');
	}
	// `name` may be null (clear) or a string. Anything else is rejected.
	const name = body.name === null ? null : sanitizeName(body.name);
	const matched = renameCredential(locals.user.id, params.id, name);
	if (!matched) throw error(404, 'Passkey not found');
	return json({ ok: true, name });
};
