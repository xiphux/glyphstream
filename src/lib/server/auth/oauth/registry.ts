/**
 * The OAuth provider registry — the single place that knows which
 * providers exist. Routes and UI loaders operate against this rather than
 * importing provider modules directly, so adding a provider is one entry
 * here plus a new module.
 */
import { githubProvider } from './github';
import { googleProvider } from './google';
import { oidcProvider } from './oidc';
import type { OAuthProvider } from './types';

/** Insertion order is the UI order: GitHub first (the original), then
 *  Google, then generic OIDC. */
const PROVIDERS: readonly OAuthProvider[] = [githubProvider, googleProvider, oidcProvider];

const BY_ID = new Map<string, OAuthProvider>(PROVIDERS.map((p) => [p.id, p]));

/** Look up a provider by id, or null if no such provider exists. Note this
 *  returns the provider regardless of whether it's enabled — callers that
 *  need the gated view should check `enabled()` (or use `getEnabledProvider`). */
export function getProvider(id: string): OAuthProvider | null {
	return BY_ID.get(id) ?? null;
}

/** Look up an *enabled* provider by id, or null if it's unknown or its
 *  flag/credentials aren't configured. The right call for the start routes:
 *  refuse to begin a flow for a provider that isn't actually available. */
export function getEnabledProvider(id: string): OAuthProvider | null {
	const p = BY_ID.get(id);
	return p && p.enabled() ? p : null;
}

export function isProviderEnabled(id: string): boolean {
	return getEnabledProvider(id) !== null;
}

/** Enabled providers in UI order — what the auth pages iterate to render
 *  their sign-in buttons. */
export function listEnabledProviders(): OAuthProvider[] {
	return PROVIDERS.filter((p) => p.enabled());
}

/** Snapshot of every *registered* provider (enabled or not) for the
 *  settings page: it labels bound accounts, flags the ones whose provider
 *  was since disabled (still rendered, just no longer a way in), and drives
 *  the "Link …" buttons (the enabled+unlinked subset). A provider the user
 *  has neither bound nor can link renders nothing — the page shows what you
 *  can act on, not a matrix of instance config. */
export function describeProviders(): Array<{ id: string; label: string; enabled: boolean }> {
	return PROVIDERS.map((p) => ({ id: p.id, label: p.label(), enabled: p.enabled() }));
}
