import type { RequestHandler } from './$types';

/** Liveness probe. Bypasses auth. */
export const GET: RequestHandler = () => Response.json({ status: 'ok' });
