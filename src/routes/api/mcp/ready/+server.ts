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
 * But not indefinitely. A held request occupies one of the browser's six
 * per-origin HTTP/1.1 connections, and bootstrap's duration is a third party's
 * to decide. The cap matches the default per-server connect timeout, which is
 * the longest a healthy bootstrap can take — so it only trips when a server is
 * hanging past its own timeout, and then we answer `ready: false` and the
 * client leaves the counts alone. They refresh on the next navigation, which
 * is exactly what happened before this endpoint existed.
 */

import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { awaitMcpReady, isMcpReady } from '$lib/server/mcp/bootstrap';
import { withSoftDeadline } from '$lib/server/mcp/registry';
import type { RequestHandler } from './$types';

/** Mirrors DEFAULT_TIMEOUT_SECONDS in mcp/config.ts. */
const READY_WAIT_CAP_MS = 30_000;

export const GET: RequestHandler = async ({ locals }) => {
	// Authenticated-only: the body carries nothing sensitive, but an anonymous
	// caller shouldn't get a handle on process lifecycle state, and shouldn't
	// be able to park connections on a deliberately-slow request.
	requireUser(locals);
	await withSoftDeadline(awaitMcpReady(), READY_WAIT_CAP_MS);
	// Distinguishes "settled, go re-read" from "gave up waiting" — the client
	// only re-pulls the layout data for the former.
	return json({ ready: isMcpReady() });
};
