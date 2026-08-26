/* @vitest-environment happy-dom */

/**
 * Holds the line on the `?link=` result toast firing once per link attempt.
 *
 * The security page reads the OAuth link outcome off the query string, toasts
 * it, and strips the param with a raw `window.history.replaceState` — which the
 * router never sees, so SvelteKit's `page.url` keeps carrying `?link=` for as
 * long as the page is mounted. That is only safe while nothing re-runs the
 * announcement, and a COMMIT is not a navigation: `page.url` is a `$state.raw`
 * holding a URL object that SvelteKit republishes on every load re-run,
 * `invalidate()` included — the (app) layout fires one on every resume. Reading
 * it from an `$effect` re-announced a link that had completed long ago.
 *
 * Lives beside SettingsSecurity.test.ts rather than in it because it needs the
 * `$app/state` page and `$app/navigation` stubbed, and those mocks are
 * file-wide.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { createKitStub } from './_helpers/kit-runtime-stub.svelte';

const holder = vi.hoisted(() => ({ current: null as ReturnType<typeof createKitStub> | null }));

function stub() {
	if (!holder.current) throw new Error('the SvelteKit runtime stub was never built');
	return holder.current;
}

vi.mock('$app/navigation', () => ({
	invalidate: vi.fn(async () => {}),
	// The page strips `?link=` with a replacing goto; it awaits the result.
	goto: vi.fn(async () => {}),
	afterNavigate: (callback: Parameters<ReturnType<typeof createKitStub>['afterNavigate']>[0]) =>
		stub().afterNavigate(callback),
}));
vi.mock('@simplewebauthn/browser', () => ({
	startRegistration: vi.fn(),
	startAuthentication: vi.fn(),
}));
vi.mock('$app/state', async () => {
	const { createKitStub } = await import('./_helpers/kit-runtime-stub.svelte');
	holder.current = createKitStub('http://localhost:3000/settings/security?link=success');
	return { page: holder.current.page, navigating: holder.current.navigating };
});

import SecurityPage from '../../src/routes/(app)/settings/security/+page.svelte';
import { goto } from '$app/navigation';
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

beforeEach(() => {
	// `vi.spyOn` on an already-spied method hands back the SAME mock, call
	// history included — without this the second test starts at one call.
	vi.restoreAllMocks();
	stub().reset();
	globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
});

describe('security page — ?link= result toast', () => {
	it('announces the result once, and not again when a refresh re-commits the URL', () => {
		const success = vi.spyOn(toast, 'success');
		render(SecurityPage, { props: { data: data as never } });
		// The provider redirects the browser here, so the page arrives on an
		// `enter` navigation carrying the param.
		stub().enter();
		flushSync();
		expect(success).toHaveBeenCalledTimes(1);
		expect(success).toHaveBeenCalledWith('Provider linked.');

		// What `invalidate()` commits: same href — the raw replaceState in the
		// page never reached the router, so `page.url` still says `link=success`
		// — with a new URL object, and no navigation.
		stub().refreshData();
		flushSync();
		stub().refreshData();
		flushSync();
		expect(success).toHaveBeenCalledTimes(1);
	});

	it('strips the param with a replacing navigation, not a shallow one', async () => {
		render(SecurityPage, { props: { data: data as never } });
		stub().enter();
		flushSync();

		// Deliberately a `goto`, not `replaceState`. Kit's `replaceState` is the
		// shallow-routing API: it records the page's REAL url — `?link=` and all
		// — in the history entry, so a later Back onto it replays the navigation
		// and announces the link a second time. Only a navigation takes the
		// param off `page.url` and off the entry.
		await vi.waitFor(() =>
			expect(vi.mocked(goto)).toHaveBeenCalledWith(
				'/settings/security',
				expect.objectContaining({ replaceState: true }),
			),
		);
	});

	it('does not replay it on a later navigation back to the stripped URL', () => {
		const success = vi.spyOn(toast, 'success');
		render(SecurityPage, { props: { data: data as never } });
		stub().enter();
		flushSync();
		expect(success).toHaveBeenCalledTimes(1);

		// A real navigation builds its URL from the link that was followed, which
		// carries no `?link=` — so there is nothing left to announce.
		stub().navigate('http://localhost:3000/settings/security');
		flushSync();
		expect(success).toHaveBeenCalledTimes(1);
	});
});
