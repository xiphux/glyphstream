import { error } from '@sveltejs/kit';

/**
 * Parse a request's JSON body, throwing a 400 on a malformed body or a
 * body that isn't a JSON object. Beyond the object check it's a type
 * assertion only — no runtime schema validation; handlers narrow the
 * specific fields they read, exactly as they did when this was inlined
 * per-route.
 */
export async function parseJsonBody<T>(request: Request): Promise<T> {
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		throw error(400, 'Request body must be JSON');
	}
	// Every caller expects a JSON object; reject null / scalar bodies up
	// front so a handler never dereferences a non-object `body`.
	if (parsed === null || typeof parsed !== 'object') {
		throw error(400, 'Request body must be a JSON object');
	}
	return parsed as T;
}
