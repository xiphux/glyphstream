import { error } from '@sveltejs/kit';

/**
 * Parse a request's JSON body, throwing a 400 on a malformed or absent
 * body. A type assertion only — no runtime schema validation; handlers
 * narrow the specific fields they read, exactly as they did when this
 * was inlined per-route.
 */
export async function parseJsonBody<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw error(400, 'Request body must be JSON');
	}
}
