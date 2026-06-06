/** True when an error is a fetch/stream abort (user Stop, navigation, or an
 *  AbortController.abort()), as opposed to a genuine failure. Both DOMException
 *  and Error shapes show up across browsers / polyfills. */
export function isAbortError(e: unknown): boolean {
	if (e instanceof DOMException && e.name === 'AbortError') return true;
	if (e instanceof Error && e.name === 'AbortError') return true;
	return false;
}
