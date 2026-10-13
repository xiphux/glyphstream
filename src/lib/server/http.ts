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
		error(400, 'Request body must be JSON');
	}
	// Every caller expects a JSON object; reject null / scalar bodies up
	// front so a handler never dereferences a non-object `body`.
	if (parsed === null || typeof parsed !== 'object') {
		error(400, 'Request body must be a JSON object');
	}
	return parsed as T;
}

/**
 * Narrow an optional string field of a parsed body. Absent (`undefined` or
 * `null`) gives `undefined`; any other non-string is a 400 naming the field.
 * `parseJsonBody` only asserts the body's type, so without this a client
 * sending `{"title": 5}` reaches `.trim()` on a number and gets a 500.
 */
export function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') error(400, `'${field}' must be a string`);
	return value;
}

/** 400 when `value` is longer than `max` characters. Returns it unchanged. */
export function requireMaxLength<T extends string | undefined>(
	value: T,
	field: string,
	max: number,
): T {
	if (value !== undefined && value.length > max) {
		error(400, `'${field}' must be ${max.toLocaleString('en-US')} characters or fewer`);
	}
	return value;
}

/** 400 when `list` has more than `max` entries. Returns it unchanged. */
export function requireMaxItems<T>(list: T[], field: string, max: number): T[] {
	if (list.length > max) error(400, `'${field}' may hold at most ${max} entries`);
	return list;
}
