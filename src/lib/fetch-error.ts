/**
 * Turn a failed `fetch` Response into a user-facing error string.
 *
 * Every client-side fetch that checks `!res.ok` needs the same thing:
 * read the JSON error body the API endpoints return ({ message }), and
 * fall back to a bare status line when there's no usable message.
 *
 * Client-safe — no server-only imports — so route components and the
 * layout can all share it.
 */
export async function errorMessageFromResponse(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { message?: unknown };
		if (body && typeof body.message === 'string' && body.message.length > 0) {
			return body.message;
		}
	} catch {
		// non-JSON / empty body — fall through to the status line
	}
	return `HTTP ${res.status}`;
}
