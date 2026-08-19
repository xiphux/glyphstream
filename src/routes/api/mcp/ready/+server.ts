/**
 * GET: resolve once MCP bootstrap has settled. `{ ready: boolean }`.
 *
 * The (app) layout renders without waiting on MCP discovery — see isMcpReady
 * for why blocking there was costing a cold start a remote handshake. What it
 * gives up is the per-server tool count and the hide-a-failed-global-server
 * flag, both of which only exist once the boot handshakes land. This endpoint
 * is how the client waits for that off the critical path.
 *
 * Deliberately holds the request open rather than answering "not yet" and
 * being polled: there is exactly one transition to wait for, it happens once
 * per process, and the caller is a background fetch with nothing rendering
 * behind it.
 *
 * But not indefinitely — a held request occupies one of the browser's six
 * per-origin HTTP/1.1 connections, and how long bootstrap runs is a third
 * party's decision. The wait comes from `healthyBootstrapBudgetMs()`, which
 * derives it from the servers actually configured; see that function for why a
 * fixed number (or one keyed off the DEFAULT_TIMEOUT_SECONDS the per-server
 * value merely defaults to) understates the real ceiling severalfold.
 *
 * Deriving it makes it correct but also unbounded above — `timeout_seconds`
 * has a floor and no ceiling, so a server configured at 600s would park a
 * connection for half an hour. HARD_CAP_MS bounds that. It sits deliberately
 * above the default configuration's own ceiling, so it never trims a wait that
 * a normally-configured deployment would actually need; it only truncates
 * settings already far outside what a page render should ever wait on.
 *
 * So overrunning it means a server is hanging past its own budget, not merely
 * being slow. We answer `ready: false`, the client leaves the counts alone,
 * and nothing retries — a hang is exactly the case where retrying would park
 * another connection for another full budget to learn the same thing.
 *
 * The counts then stay stale until the next FULL load, not merely the next
 * navigation: for an authenticated request the (app) layout load never reads
 * `url` (only the signed-out redirect branch does), so SvelteKit records no
 * `uses.url` and a client-side navigation does not re-run it. Only a reload or
 * one of its `depends()` keys does. That is a cosmetic tool count against a
 * server that is genuinely hanging, which is the same thing the operator will
 * be seeing on /settings/mcp.
 */

import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { awaitMcpReady, isMcpReady } from '$lib/server/mcp/bootstrap';
import { healthyBootstrapBudgetMs, withSoftDeadline } from '$lib/server/mcp/registry';
import type { RequestHandler } from './$types';

/**
 * Ceiling on the derived wait, for a pathologically-configured server. Above
 * the 90s a default-configured server can legitimately reach, so it changes
 * nothing for a normal deployment.
 */
const HARD_CAP_MS = 120_000;

export const GET: RequestHandler = async ({ locals }) => {
	// Authenticated-only: the body carries nothing sensitive, but an anonymous
	// caller shouldn't get a handle on process lifecycle state, and shouldn't
	// be able to park connections on a deliberately-slow request.
	requireUser(locals);
	await withSoftDeadline(awaitMcpReady(), Math.min(healthyBootstrapBudgetMs(), HARD_CAP_MS));
	// Distinguishes "settled, go re-read" from "gave up waiting" — the client
	// only re-pulls the layout data for the former.
	return json({ ready: isMcpReady() });
};
