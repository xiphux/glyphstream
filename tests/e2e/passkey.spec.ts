/**
 * A real passkey ceremony, end to end: @simplewebauthn/browser in Chromium
 * talking to @simplewebauthn/server through our routes, with Chromium's virtual
 * authenticator standing in for a platform authenticator.
 *
 * Every other passkey test mocks one side (passkey-helper, SetupPage,
 * SettingsSecurity), so a minor of either package that changed option shapes,
 * response encoding, or verification checks would merge green — and the
 * failure would be every passkey login in production.
 *
 * Registers a passkey from /settings/security in the signed-in context, then
 * signs in with it from a fresh signed-out context. The credential moves between
 * the two virtual authenticators over CDP; the signed-in test session is never
 * logged out, so later specs keep it.
 */
import { test, expect, type BrowserContext, type Page } from './fixtures/test';
import { resetData } from './helpers';

test.skip(({ browserName }) => browserName !== 'chromium', 'virtual authenticator is CDP-only');

async function addVirtualAuthenticator(context: BrowserContext, page: Page) {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	return { cdp, authenticatorId };
}

test.beforeEach(() => {
	resetData();
});

test('register a passkey, then sign in with it', async ({ browser, context, page }) => {
	// --- register, as the signed-in test user --------------------------------
	const reg = await addVirtualAuthenticator(context, page);
	await page.goto('/settings/security');
	await page.getByRole('button', { name: 'Add passkey' }).click();
	await expect(page.getByText('Passkey added.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Rename passkey' })).toHaveCount(1);

	const { credentials } = await reg.cdp.send('WebAuthn.getCredentials', {
		authenticatorId: reg.authenticatorId,
	});
	expect(credentials).toHaveLength(1);
	// Discoverable: the login ceremony is usernameless (allowCredentials: []),
	// so the browser must find this credential by rpId alone.
	expect(credentials[0].isResidentCredential).toBe(true);

	// --- sign in, signed out, with the same credential -----------------------
	const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const loginPage = await anon.newPage();
	const auth = await addVirtualAuthenticator(anon, loginPage);
	await auth.cdp.send('WebAuthn.addCredential', {
		authenticatorId: auth.authenticatorId,
		credential: credentials[0],
	});

	await loginPage.goto('/login');
	await loginPage.getByRole('button', { name: 'Sign in with a passkey' }).click();

	// Verified: a session cookie is set and the full navigation lands in the app.
	await loginPage.waitForURL((url) => url.pathname === '/');
	await expect(loginPage.getByRole('button', { name: 'Select model' })).toBeVisible();
	const cookies = await anon.cookies();
	expect(cookies.some((c) => /session/i.test(c.name))).toBe(true);

	// The assertion counter advanced on the authenticator; the server accepted
	// it, so a replay of the same signature would now be refused.
	const after = await auth.cdp.send('WebAuthn.getCredentials', {
		authenticatorId: auth.authenticatorId,
	});
	expect(after.credentials[0].signCount).toBeGreaterThan(credentials[0].signCount);

	await anon.close();
});
