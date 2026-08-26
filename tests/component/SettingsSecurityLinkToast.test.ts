/* @vitest-environment happy-dom */

/**
 * Holds the line on the `?link=` result toast firing once per link attempt.
 *
 * The security page reads the OAuth link outcome off the query string, toasts
 * it, and strips the param with a raw `window.history.replaceState` — which the
 * router never sees, so SvelteKit's `page.url` keeps carrying `?link=`. That is
 * only safe while nothing re-runs the effect, and something does: `page.url` is
 * a `$state.raw` holding a URL object, and SvelteKit publishes a `new URL(...)`
 * on every load re-run whose data changed — every `invalidate()`, including the
 * (app) layout's refresh on resume. Without a latch on the value, returning to
 * a backgrounded app re-announced a link that completed long ago.
 *
 * Lives beside SettingsSecurity.test.ts rather than in it because it needs the
 * `$app/state` page stubbed, and that mock is file-wide.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { createPageStub } from './_helpers/page-state-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createPageStub> | null }));

vi.mock('$app/navigation', () => ({ invalidate: vi.fn(async () => {}), goto: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
	startRegistration: vi.fn(),
	startAuthentication: vi.fn(),
}));
vi.mock('$app/state', async () => {
	const { createPageStub } = await import('./_helpers/page-state-stub.svelte');
	holder.current = createPageStub('http://localhost:3000/settings/security?link=success');
	return { page: holder.current.page, navigating: holder.current.navigating };
});

import SecurityPage from '../../src/routes/(app)/settings/security/+page.svelte';
import { toast } from '$lib/toast.svelte';

const data = {
	providers: [{ id: 'github', label: 'GitHub', enabled: true }],
	passkeyEnabled: true,
	passkeys: [],
	oauthAccounts: [
		{
			provider: 'github',
			externalId: '42',
			externalUsername: 'octocat',
			externalEmail: null,
			createdAt: Date.now(),
		},
	],
	sessions: [],
	currentSessionId: null,
};

function stub() {
	if (!holder.current) throw new Error('$app/state stub was never built');
	return holder.current;
}

beforeEach(() => {
	globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
});

describe('security page — ?link= result toast', () => {
	it('announces the result once, and not again when a refresh re-commits the URL', () => {
		const success = vi.spyOn(toast, 'success');
		render(SecurityPage, { props: { data: data as never } });
		flushSync();
		expect(success).toHaveBeenCalledTimes(1);
		expect(success).toHaveBeenCalledWith('Provider linked.');

		// What `invalidate()` commits: same href — the raw replaceState above
		// never reached the router — with a new URL object.
		stub().refreshData();
		flushSync();
		stub().refreshData();
		flushSync();
		expect(success).toHaveBeenCalledTimes(1);
	});
});
