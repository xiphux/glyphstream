import { loadEndpoints, type LoadedEndpoint } from './config';
import { memoizeConfig } from '../util/config-cache';

/**
 * Build (and memoize) the endpoint registry on first access.
 *
 * Only a map built in full is remembered: a throw from loadEndpoints()
 * mid-build is not cached (see memoizeConfig), so the next caller retries.
 * Caching a half-built (empty) map instead would make a transient
 * file-read or env-resolution failure look like "endpoints aren't
 * configured" for the life of the process.
 */
export const getRegistry = memoizeConfig((): Map<string, LoadedEndpoint> => {
	const next = new Map<string, LoadedEndpoint>();
	for (const ep of loadEndpoints()) {
		next.set(ep.id, ep);
	}
	return next;
});

export function getEndpoint(id: string): LoadedEndpoint | undefined {
	return getRegistry().get(id);
}

export function listEndpoints(): LoadedEndpoint[] {
	return [...getRegistry().values()];
}
