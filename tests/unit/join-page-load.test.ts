/** The invite page's session gates: it is for browsers with no account. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/server/db/queries/invites.js', () => ({ findValidInvite: () => ({ id: 'i1' }) }));
vi.mock('#lib/server/env.js', () => ({ passkeyLoginEnabled: () => true }));
vi.mock('#lib/server/auth/oauth/registry.js', () => ({ listEnabledProviders: () => [] }));

import { load } from '../../src/routes/(auth)/join/[token]/+page.server';

function run(locals: Partial<App.Locals>): unknown {
	try {
		return load({
			params: { token: 't' },
			url: new URL('https://x.test/join/t'),
			locals: { user: null, appLock: null, ...locals },
		} as unknown as Parameters<typeof load>[0]);
	} catch (e) {
		return e;
	}
}

describe('/join/[token] load', () => {
	it('renders the wizard for a browser with no session', () => {
		expect(run({})).toMatchObject({ valid: true, token: 't' });
	});

	it('sends a signed-in user home', () => {
		expect(run({ user: { id: 'u', role: 'user' } as App.Locals['user'] })).toMatchObject({
			status: 302,
			location: '/',
		});
	});

	it('sends an app-locked session to /unlock, not into sign-up', () => {
		expect(run({ appLock: { locked: true } as App.Locals['appLock'] })).toMatchObject({
			status: 302,
			location: '/unlock',
		});
	});
});
