/**
 * The two routes that start an OAuth round-trip must hand the browser to the
 * identity provider: a 302 whose Location is the provider's authorization URL.
 *
 * Since SvelteKit 3, `redirect()` refuses a target on another origin unless the
 * call opts in with `external`, and refuses it by throwing a plain Error — so a
 * missing opt-in doesn't fail a type-check or a build, it turns every "Sign in
 * with …" and "Link account" click into a 500. Nothing else drives these
 * routes (e2e signs in by seeding a session), which is how the upgrade shipped
 * without the opt-in once. This holds the line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRedirect, type Cookies } from '@sveltejs/kit';

const getEnabledProviderMock = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/auth/oauth/registry.js', () => ({
	getEnabledProvider: getEnabledProviderMock,
}));
// The carry cookies are signed; what they hold isn't this test's subject.
vi.mock('#lib/server/auth/signed-cookies.js', () => ({ setCarryCookie: vi.fn() }));

import { GET as loginGET } from '../../src/routes/api/auth/oauth/[provider]/login/+server';
import { GET as linkStartGET } from '../../src/routes/api/auth/oauth/[provider]/link/start/+server';

const AUTHORIZE = 'https://idp.example.com/oauth/authorize?client_id=c&state=s';

function mkEvent(provider: string) {
	return {
		cookies: {} as Cookies,
		locals: { user: { id: 'u1' } },
		params: { provider },
	};
}

async function locationOf(fn: () => unknown): Promise<string> {
	try {
		await fn();
	} catch (e) {
		if (isRedirect(e)) {
			expect(e.status).toBe(302);
			return e.location;
		}
		throw e;
	}
	throw new Error('expected a redirect, none thrown');
}

beforeEach(() => {
	getEnabledProviderMock.mockReset();
	getEnabledProviderMock.mockReturnValue({
		createAuthorizationURL: () =>
			Promise.resolve({ url: new URL(AUTHORIZE), state: 's', codeVerifier: null }),
	});
});

describe('OAuth start routes redirect to the identity provider', () => {
	it('login', async () => {
		expect(await locationOf(() => loginGET(mkEvent('github') as never))).toBe(AUTHORIZE);
	});

	it('link/start', async () => {
		expect(await locationOf(() => linkStartGET(mkEvent('github') as never))).toBe(AUTHORIZE);
	});
});
