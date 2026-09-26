/**
 * App lock, end to end: a locked session is turned away from the app and the
 * API, lands on /unlock, and a real passkey ceremony (Chromium's virtual
 * authenticator against @simplewebauthn/server) lets it back in — to the page it
 * was headed for.
 *
 * The lock itself is seeded (mintLockedSession) rather than reached through the
 * idle clock: that clock only runs for the installed app and needs a wait, and
 * the born-locked state is the same `locals.appLock.locked` every guard reads.
 * The unit tests own evaluateAppLock's timing; this owns the round trip.
 *
 * Runs as the non-admin user so the admin session every other spec shares is
 * never near a lock. resetData() takes the setting and the minted session away.
 */
import { test, expect, type BrowserContext, type Page } from './fixtures/test';
import { mintLockedSession, resetData } from './helpers';
import { STORAGE_STATE_USER2_PATH, TEST_USER_2 } from './global-setup';

test.skip(({ browserName }) => browserName !== 'chromium', 'virtual authenticator is CDP-only');

// Same authenticator as passkey.spec.ts: user-verifying, auto-approving.
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

test('a locked session is sent to /unlock and a passkey lets it back in', async ({ browser }) => {
	// --- register a passkey for the user, from their ordinary session ---------
	const signedIn = await browser.newContext({ storageState: STORAGE_STATE_USER2_PATH });
	let credential;
	try {
		const page = await signedIn.newPage();
		const reg = await addVirtualAuthenticator(signedIn, page);
		await page.goto('/settings/security');
		await page.getByRole('button', { name: 'Add passkey' }).click();
		await expect(page.getByText('Passkey added.')).toBeVisible();
		const { credentials } = await reg.cdp.send('WebAuthn.getCredentials', {
			authenticatorId: reg.authenticatorId,
		});
		expect(credentials).toHaveLength(1);
		credential = credentials[0];
	} finally {
		await signedIn.close();
	}

	// --- a second, locked session for the same user ---------------------------
	const locked = await browser.newContext({ storageState: mintLockedSession(TEST_USER_2.id) });
	try {
		const page = await locked.newPage();

		// Refused everywhere, as "locked" rather than "signed out": pages go to
		// /unlock carrying where they were headed, the API answers 423.
		const raw = await page.request.get('/settings/preferences', { maxRedirects: 0 });
		expect(raw.status()).toBe(302);
		expect(raw.headers()['location']).toBe('/unlock?from=%2Fsettings%2Fpreferences');
		expect((await page.request.get('/api/conversations')).status()).toBe(423);

		// The lock screen renders for it (not a redirect onward).
		const unlockRaw = await page.request.get('/unlock', { maxRedirects: 0 });
		expect(unlockRaw.status()).toBe(200);

		// The authenticator goes on before the navigation: /unlock starts the
		// ceremony on mount, and it must find the credential there.
		const auth = await addVirtualAuthenticator(locked, page);
		await auth.cdp.send('WebAuthn.addCredential', {
			authenticatorId: auth.authenticatorId,
			credential,
		});

		await page.goto('/settings/preferences');
		// Unlocked on arrival, and returned to the page it asked for.
		await page.waitForURL((url) => url.pathname === '/settings/preferences');
		expect((await page.request.get('/api/conversations')).status()).toBe(200);
	} finally {
		await locked.close();
	}
});

test('the lock screen renders and offers the unlock, without a passkey to hand', async ({
	browser,
}) => {
	// No authenticator and no registered passkey: the on-mount ceremony fails,
	// and the page must say so and leave both ways out usable — not wedge.
	const locked = await browser.newContext({ storageState: mintLockedSession(TEST_USER_2.id) });
	try {
		const page = await locked.newPage();
		await page.goto('/');
		await expect(page).toHaveURL(/\/unlock\?from=%2F$/);
		await expect(page.getByRole('heading', { name: 'GlyphStream is locked' })).toBeVisible();
		await expect(page.getByText('This account has no passkeys')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Unlock' })).toBeEnabled();
	} finally {
		await locked.close();
	}
});
