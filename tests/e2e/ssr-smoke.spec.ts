/**
 * Every page route renders: server-side, and after hydration in a real browser.
 *
 * Most specs visit a handful of pages on their way to a flow, so a page no flow
 * touches (settings/mcp, settings/permissions, settings/security, settings/skills,
 * /setup) was never server-rendered in CI at all. A Svelte / Kit / bits-ui minor
 * that breaks SSR or hydration on one of those would merge green. This walks all
 * of them as the admin, as a normal user (admin-only pages must refuse cleanly,
 * not 500), and signed out for the auth pages.
 *
 * Failures come from two places: a status >= 400 here (>= 500 for pages the
 * role isn't allowed on), and the fixtures/test.ts auto-check, which fails the
 * test on any server console.error or uncaught page error the render produced.
 *
 * ROUTES must name every +page.svelte under src/routes; the first test fails
 * when a page is added without an entry.
 */
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { test, expect, type Browser, type Page } from './fixtures/test';
import { mintLockedSession, resetData, seedConversation } from './helpers';
import { STORAGE_STATE_USER2_PATH, TEST_USER_2 } from './global-setup';

/** `locked`: the non-admin user on a session app lock is holding (see
 *  mintLockedSession) — the only identity /unlock renders its own page for. */
type Who = 'admin' | 'user' | 'anon' | 'locked';

interface RouteCase {
	/** Concrete URL to request; called after resetData() so seeds are fresh. */
	path: () => string;
	/** Roles expected to render the page (status < 400). */
	renders: Who[];
	/** Roles expected to be turned away without a server error (status < 500). */
	refused?: Who[];
}

const ROUTES: Record<string, RouteCase> = {
	'/(app)': { path: () => '/', renders: ['admin', 'user'] },
	'/(app)/archived': { path: () => '/archived', renders: ['admin', 'user'] },
	'/(app)/chat/[id]': {
		path: () => `/chat/${seedConversation('ssr smoke')}`,
		renders: ['admin'],
		// Another user's conversation: must 404, not 500.
		refused: ['user'],
	},
	'/(app)/gallery': { path: () => '/gallery', renders: ['admin', 'user'] },
	'/(app)/settings/endpoints': {
		path: () => '/settings/endpoints',
		renders: ['admin'],
		refused: ['user'],
	},
	'/(app)/settings/mcp': { path: () => '/settings/mcp', renders: ['admin', 'user'] },
	'/(app)/settings/memories': { path: () => '/settings/memories', renders: ['admin', 'user'] },
	'/(app)/settings/models': { path: () => '/settings/models', renders: ['admin', 'user'] },
	'/(app)/settings/permissions': {
		path: () => '/settings/permissions',
		renders: ['admin', 'user'],
	},
	'/(app)/settings/preferences': {
		path: () => '/settings/preferences',
		renders: ['admin', 'user'],
	},
	'/(app)/settings/security': { path: () => '/settings/security', renders: ['admin', 'user'] },
	'/(app)/settings/skills': { path: () => '/settings/skills', renders: ['admin', 'user'] },
	'/(app)/settings/snippets': { path: () => '/settings/snippets', renders: ['admin', 'user'] },
	'/(app)/settings/users': {
		path: () => '/settings/users',
		renders: ['admin'],
		refused: ['user'],
	},
	// The auth group: signed-out pages. /setup is closed once an admin exists
	// and /join with a bogus token shows its invalid-invite state — both must
	// still render (or redirect) without erroring.
	'/(auth)/join/[token]': { path: () => '/join/not-a-real-invite-token', renders: ['anon'] },
	'/(auth)/login': { path: () => '/login', renders: ['anon'] },
	'/(auth)/setup': { path: () => '/setup', renders: ['anon'] },
	// Renders its own page only for a locked session; unlocked it bounces to
	// `from`, signed out to /login. The redirects must come back clean too.
	'/(auth)/unlock': { path: () => '/unlock', renders: ['locked', 'anon', 'admin'] },
};

function pageRouteIds(): string[] {
	const root = join(process.cwd(), 'src', 'routes');
	const ids: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === '+page.svelte') {
				const rel = relative(root, dir).split(sep).join('/');
				ids.push(rel === '' ? '/' : `/${rel}`);
			}
		}
	};
	walk(root);
	return ids.sort();
}

/** Run `fn` with a page signed in as `who`. A non-admin role gets its own
 *  context, closed even when an assertion inside `fn` fails. */
async function asRole(
	browser: Browser,
	page: Page,
	who: Who,
	fn: (p: Page) => Promise<void>,
): Promise<void> {
	if (who === 'admin') return fn(page);
	const ctx = await browser.newContext({
		storageState:
			who === 'user'
				? STORAGE_STATE_USER2_PATH
				: who === 'locked'
					? mintLockedSession(TEST_USER_2.id)
					: { cookies: [], origins: [] },
	});
	try {
		await fn(await ctx.newPage());
	} finally {
		await ctx.close();
	}
}

test('the route list covers every +page.svelte', () => {
	expect(Object.keys(ROUTES).sort()).toEqual(pageRouteIds());
});

for (const [routeId, route] of Object.entries(ROUTES)) {
	test.describe(`SSR smoke: ${routeId}`, () => {
		test.beforeEach(() => {
			resetData();
		});

		for (const who of route.renders) {
			test(`renders as ${who}`, async ({ browser, page }) => {
				await asRole(browser, page, who, async (p) => {
					const path = route.path();

					// Server render alone, before any client code runs.
					const raw = await p.request.get(path, { maxRedirects: 0 });
					expect(raw.status(), `SSR status for ${path}`).toBeLessThan(400);

					// Full navigation: follows redirects and hydrates. A hydration
					// failure surfaces as a page error, which the fixture turns into a
					// test failure.
					const res = await p.goto(path);
					expect(res?.status(), `navigation status for ${path}`).toBeLessThan(400);
					await expect(p.locator('body')).not.toBeEmpty();
					await p.waitForLoadState('load');
				});
			});
		}

		for (const who of route.refused ?? []) {
			test(`refuses ${who} without a server error`, async ({ browser, page }) => {
				await asRole(browser, page, who, async (p) => {
					const path = route.path();
					const raw = await p.request.get(path, { maxRedirects: 0 });
					expect(raw.status(), `status for ${who} on ${path}`).toBeLessThan(500);
				});
			});
		}
	});
}
