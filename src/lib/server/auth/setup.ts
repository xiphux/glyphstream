/**
 * Central gate for the first-run `/setup` wizard. Two structural facts
 * drive the verdict:
 *
 *  1. Whether any user exists. Once one does, setup is `closed` —
 *     every entry point (the page, the /api/auth/setup/* endpoints,
 *     the layout redirect) needs to honor that uniformly. Single-user
 *     cap, baked in.
 *
 *  2. Whether the request carries the matching `SETUP_TOKEN` in
 *     `?token=…`, compared in constant time.
 *
 * The three verdicts let callers decide whether to render the wizard,
 * 403 with a clear error, or redirect to /login (because there's
 * nothing to set up anymore).
 *
 * ## Why a token is always required
 *
 * `SETUP_TOKEN` used to be opt-in, and shipped commented out — so the
 * default posture on a fresh install was an open wizard. Anyone who reached
 * the host between `docker compose up` and the operator finishing setup could
 * claim the admin account, which then closes `/setup` structurally against
 * the real operator; recovery means hand-editing SQLite. The window is small
 * but it's exactly the window where DNS has been pointed at a new host and
 * nobody is watching it yet.
 *
 * When the operator hasn't set one, we now mint a random token for the
 * process and print it to stderr with the URL to use. First run costs a
 * glance at the logs (`docker compose logs`); an unattended instance is no
 * longer claimable. The generated token lives only in memory, so a restart
 * before setup completes mints a new one — fine, since the operator is
 * reading the log either way.
 *
 * Generation is lazy, inside the `countUsers() === 0` branch, so an
 * established instance never mints or logs anything.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { countUsers } from '../db/queries/users';
import { publicBaseUrl, setupToken } from '../env';

/**
 * Cookie names used by the /setup flows. They live here rather than in
 * the `+server.ts` files because SvelteKit validates route-file exports
 * against a fixed list (HTTP method handlers + a few config slots) —
 * route files can't share named constants.
 */
export const SETUP_OAUTH_CARRY_COOKIE = 'glyphstream_setup_oauth_carry';
export const SETUP_PASSKEY_CARRY_COOKIE = 'glyphstream_setup_passkey_carry';

export type SetupGateVerdict = 'allowed' | 'needs-token' | 'closed';

/**
 * The process-lifetime token minted when the operator didn't configure one.
 * Null until the first gate check on an install with no users.
 */
let generatedToken: string | null = null;

/**
 * The token `/setup` requires: the operator's if configured, otherwise one
 * minted for this process and announced on stderr.
 */
function effectiveSetupToken(): string {
	const configured = setupToken();
	if (configured) return configured;
	if (!generatedToken) {
		generatedToken = randomBytes(24).toString('base64url');
		const base = publicBaseUrl().replace(/\/+$/, '');
		console.warn(
			`\n[setup] No SETUP_TOKEN configured. First-run setup requires this one-time URL:\n` +
				`[setup]   ${base}/setup?token=${generatedToken}\n` +
				`[setup] It is valid until this process restarts. Set SETUP_TOKEN in .env to pin your own.\n`,
		);
	}
	return generatedToken;
}

export function setupGate(url: URL): SetupGateVerdict {
	if (countUsers() > 0) return 'closed';
	const expected = effectiveSetupToken();
	const got = url.searchParams.get('token') ?? '';
	const expectedBuf = Buffer.from(expected, 'utf8');
	const gotBuf = Buffer.from(got, 'utf8');
	// The length pre-check is a length side channel, but only for a token the
	// caller is already being handed in a log line or set themselves — there's
	// no secret here that constant-time comparison of unequal-length buffers
	// would protect. timingSafeEqual requires equal lengths to run at all.
	if (expectedBuf.length !== gotBuf.length) return 'needs-token';
	if (!timingSafeEqual(expectedBuf, gotBuf)) return 'needs-token';
	return 'allowed';
}

/** Test seam: forget the generated token so a test can observe minting. */
export function _resetGeneratedSetupTokenForTests(): void {
	generatedToken = null;
}
