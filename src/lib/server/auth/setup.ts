/**
 * Central gate for the first-run `/setup` wizard. Two structural facts
 * drive the verdict:
 *
 *  1. Whether any user exists. Once one does, setup is `closed` —
 *     every entry point (the page, the /api/auth/setup/* endpoints,
 *     the layout redirect) needs to honor that uniformly. Single-user
 *     cap, baked in.
 *
 *  2. Whether the operator opted into the optional `SETUP_TOKEN`
 *     defense. When set, requests must echo back the matching token
 *     in `?token=…`; constant-time compared so token-presence isn't
 *     a side-channel for length probing.
 *
 * The three verdicts let callers decide whether to render the wizard,
 * 403 with a clear error, or redirect to /login (because there's
 * nothing to set up anymore).
 */
import { timingSafeEqual } from 'node:crypto';
import { countUsers } from '../db/queries/users';
import { setupToken } from '../env';

/**
 * Cookie names used by the /setup flows. They live here rather than in
 * the `+server.ts` files because SvelteKit validates route-file exports
 * against a fixed list (HTTP method handlers + a few config slots) —
 * route files can't share named constants.
 */
export const SETUP_OAUTH_CARRY_COOKIE = 'glyphstream_setup_oauth_carry';
export const SETUP_PASSKEY_CARRY_COOKIE = 'glyphstream_setup_passkey_carry';

export type SetupGateVerdict = 'allowed' | 'needs-token' | 'closed';

export function setupGate(url: URL): SetupGateVerdict {
	if (countUsers() > 0) return 'closed';
	const expected = setupToken();
	if (!expected) return 'allowed';
	const got = url.searchParams.get('token') ?? '';
	const expectedBuf = Buffer.from(expected, 'utf8');
	const gotBuf = Buffer.from(got, 'utf8');
	if (expectedBuf.length !== gotBuf.length) return 'needs-token';
	if (!timingSafeEqual(expectedBuf, gotBuf)) return 'needs-token';
	return 'allowed';
}
