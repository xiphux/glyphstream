/**
 * DELETE /api/auth/passkey/:id — remove a passkey credential.
 * PATCH /api/auth/passkey/:id — rename a passkey credential.
 *
 * Both endpoints scope every mutation by user_id at the query layer, so
 * a fabricated id or another user's id surfaces as a 404, not a touched
 * foreign row.
 *
 * Last-method guard on DELETE: a user must always have ≥1 viable login
 * method. When GITHUB_LOGIN_ENABLED is false AND this is the user's
 * only registered passkey, refuse the delete with a 409 so they can't
 * lock themselves out.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import {
	countCredentialsForUser,
	deleteCredential,
	renameCredential,
} from '$lib/server/db/queries/passkey';
import { githubLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

const MAX_NAME_LENGTH = 60;

function sanitizeName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim().slice(0, MAX_NAME_LENGTH);
	return trimmed.length > 0 ? trimmed : null;
}

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	if (!githubLoginEnabled() && countCredentialsForUser(locals.user.id) <= 1) {
		throw error(
			409,
			"Can't delete your last sign-in method. Re-enable GitHub login or add another passkey first.",
		);
	}
	const matched = deleteCredential(locals.user.id, params.id);
	if (!matched) throw error(404, 'Passkey not found');
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
