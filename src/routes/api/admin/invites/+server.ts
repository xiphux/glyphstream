/**
 * POST /api/admin/invites — mint an invite (admin only). Returns the raw
 * token ONCE; the client builds the /join/<token> link and shows it. Only
 * the token's hash is persisted, so it can never be re-surfaced — losing it
 * means revoking and minting a new one.
 */
import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { createInvite } from '$lib/server/db/queries/invites';
import type { UserRole } from '$lib/server/db/queries/users';
import type { RequestHandler } from './$types';

// 7-day default window — long enough to share an invite and have it redeemed,
// short enough that a leaked-but-unused link doesn't linger indefinitely.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await parseJsonBody<{ role?: unknown; ttlMs?: unknown }>(request);

	const role: UserRole = body.role === 'admin' ? 'admin' : 'user';
	let ttlMs =
		typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) ? body.ttlMs : DEFAULT_TTL_MS;
	if (ttlMs < 60_000) ttlMs = 60_000;
	if (ttlMs > MAX_TTL_MS) ttlMs = MAX_TTL_MS;

	const invite = createInvite({ createdByUserId: locals.user.id, role, ttlMs });
	if (!invite) throw error(500, 'Failed to create invite');

	// The raw token is returned only here; the client assembles the join URL
	// from its own origin so this endpoint needs no base-URL config.
	return json({ id: invite.id, token: invite.token, role, expiresAt: invite.expiresAt });
};
