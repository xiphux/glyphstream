import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	baseUrl: 'https://chat.example.com',
}));
vi.mock('$lib/server/env', () => ({
	publicBaseUrl: () => mocks.baseUrl,
}));

// Stub @simplewebauthn/server so we can assert on the pass-through
// parameters without involving real crypto. The wrappers are the unit
// under test here; the SDK's verification correctness is its own
// responsibility.
const generateRegistrationOptionsMock = vi.fn();
const verifyRegistrationResponseMock = vi.fn();
const generateAuthenticationOptionsMock = vi.fn();
const verifyAuthenticationResponseMock = vi.fn();
vi.mock('@simplewebauthn/server', () => ({
	generateRegistrationOptions: (...args: unknown[]) => generateRegistrationOptionsMock(...args),
	verifyRegistrationResponse: (...args: unknown[]) => verifyRegistrationResponseMock(...args),
	generateAuthenticationOptions: (...args: unknown[]) => generateAuthenticationOptionsMock(...args),
	verifyAuthenticationResponse: (...args: unknown[]) => verifyAuthenticationResponseMock(...args),
}));

import {
	RP_NAME,
	decodeUserHandle,
	generateAuthenticationOptionsAny,
	generateRegistrationOptionsForUser,
	getExpectedOrigin,
	getRpId,
	resetRpCache,
	setRegistrationChallengeCookie,
	verifyAuthentication,
	verifyRegistration,
	verifyRegistrationCeremony,
} from '$lib/server/auth/passkey';
import type { PasskeyCredentialRow } from '$lib/server/db/queries/passkey';
import type { SessionUser } from '$lib/server/auth/session';
import type { Cookies } from '@sveltejs/kit';

beforeEach(() => {
	resetRpCache();
	mocks.baseUrl = 'https://chat.example.com';
	generateRegistrationOptionsMock.mockReset().mockResolvedValue({ challenge: 'reg-challenge' });
	verifyRegistrationResponseMock.mockReset().mockResolvedValue({ verified: true });
	generateAuthenticationOptionsMock.mockReset().mockResolvedValue({ challenge: 'auth-challenge' });
	verifyAuthenticationResponseMock.mockReset().mockResolvedValue({ verified: true });
});

afterEach(() => {
	resetRpCache();
});

describe('getRpId / getExpectedOrigin', () => {
	it('derives the RP ID as the bare hostname (no scheme, no port)', () => {
		mocks.baseUrl = 'https://chat.example.com';
		expect(getRpId()).toBe('chat.example.com');
	});

	it('strips a non-default port from the RP ID', () => {
		mocks.baseUrl = 'https://chat.example.com:8443';
		expect(getRpId()).toBe('chat.example.com');
	});

	it('returns the full origin (scheme + host + port) for expectedOrigin', () => {
		mocks.baseUrl = 'https://chat.example.com:8443';
		expect(getExpectedOrigin()).toBe('https://chat.example.com:8443');
	});

	it('caches the parsed values', () => {
		const a = getRpId();
		mocks.baseUrl = 'https://something-else.example.com';
		// Cache should still serve the old value until reset.
		expect(getRpId()).toBe(a);
		resetRpCache();
		expect(getRpId()).toBe('something-else.example.com');
	});
});

describe('generateRegistrationOptionsForUser', () => {
	const user: SessionUser = {
		id: 'abc-123',
		displayName: 'The Octocat',
		email: 'octo@example.test',
		role: 'user',
	};

	function makeCredentialRow(over: Partial<PasskeyCredentialRow> = {}): PasskeyCredentialRow {
		return {
			id: over.id ?? 'cred',
			userId: over.userId ?? user.id,
			publicKey: over.publicKey ?? new Uint8Array([1]),
			counter: over.counter ?? 0,
			transports: 'transports' in over ? over.transports! : ['internal'],
			backedUp: over.backedUp ?? true,
			deviceType: over.deviceType ?? 'multiDevice',
			name: over.name ?? null,
			createdAt: over.createdAt ?? 0,
			lastUsedAt: over.lastUsedAt ?? null,
		};
	}

	it('passes RP name + RP ID + user identity to the SDK', async () => {
		await generateRegistrationOptionsForUser(user, []);
		const opts = generateRegistrationOptionsMock.mock.calls[0][0];
		expect(opts.rpName).toBe(RP_NAME);
		expect(opts.rpID).toBe('chat.example.com');
		// Email is the closest thing to a stable user-palatable handle.
		expect(opts.userName).toBe('octo@example.test');
		expect(opts.userDisplayName).toBe('The Octocat');
	});

	it('encodes user.id as UTF-8 bytes for the userID field', async () => {
		await generateRegistrationOptionsForUser(user, []);
		const opts = generateRegistrationOptionsMock.mock.calls[0][0];
		expect(opts.userID).toBeInstanceOf(Uint8Array);
		const decoded = Buffer.from(opts.userID).toString('utf8');
		expect(decoded).toBe('abc-123');
	});

	it('falls back to email when displayName is null', async () => {
		await generateRegistrationOptionsForUser({ ...user, displayName: null }, []);
		const opts = generateRegistrationOptionsMock.mock.calls[0][0];
		expect(opts.userDisplayName).toBe('octo@example.test');
	});

	it('falls back to id for userName when neither email nor displayName is set', async () => {
		await generateRegistrationOptionsForUser({ ...user, displayName: null, email: null }, []);
		const opts = generateRegistrationOptionsMock.mock.calls[0][0];
		expect(opts.userName).toBe('abc-123');
		expect(opts.userDisplayName).toBe('Operator');
	});

	it('requires user verification and sets attestation to none', async () => {
		await generateRegistrationOptionsForUser(user, []);
		const opts = generateRegistrationOptionsMock.mock.calls[0][0];
		expect(opts.authenticatorSelection?.userVerification).toBe('required');
		expect(opts.authenticatorSelection?.residentKey).toBe('preferred');
		expect(opts.attestationType).toBe('none');
	});

	it('emits excludeCredentials from existing rows including transports', async () => {
		await generateRegistrationOptionsForUser(user, [
			makeCredentialRow({ id: 'a', transports: ['internal'] }),
			makeCredentialRow({ id: 'b', transports: null }),
		]);
		const opts = generateRegistrationOptionsMock.mock.calls[0][0];
		expect(opts.excludeCredentials).toEqual([
			{ id: 'a', transports: ['internal'] },
			{ id: 'b', transports: undefined },
		]);
	});
});

describe('verifyRegistration', () => {
	it('passes the response, challenge, RP ID, origin, and requireUserVerification', async () => {
		const fakeResponse = { id: 'resp' } as unknown as Parameters<typeof verifyRegistration>[0];
		await verifyRegistration(fakeResponse, 'expected-challenge');
		const opts = verifyRegistrationResponseMock.mock.calls[0][0];
		expect(opts.response).toBe(fakeResponse);
		expect(opts.expectedChallenge).toBe('expected-challenge');
		expect(opts.expectedRPID).toBe('chat.example.com');
		expect(opts.expectedOrigin).toBe('https://chat.example.com');
		expect(opts.requireUserVerification).toBe(true);
	});
});

describe('generateAuthenticationOptionsAny', () => {
	it('emits an empty allowCredentials and requires user verification', async () => {
		await generateAuthenticationOptionsAny();
		const opts = generateAuthenticationOptionsMock.mock.calls[0][0];
		expect(opts.rpID).toBe('chat.example.com');
		expect(opts.allowCredentials).toEqual([]);
		expect(opts.userVerification).toBe('required');
	});
});

describe('verifyAuthentication', () => {
	it('passes the credential + RP ID + origin to the SDK with UV required', async () => {
		const fakeResponse = { id: 'r' } as unknown as Parameters<typeof verifyAuthentication>[0];
		await verifyAuthentication(fakeResponse, {
			expectedChallenge: 'chal',
			credential: {
				id: 'c',
				publicKey: new Uint8Array([1, 2, 3]),
				counter: 4,
				transports: ['internal'],
			},
		});
		const opts = verifyAuthenticationResponseMock.mock.calls[0][0];
		expect(opts.expectedChallenge).toBe('chal');
		expect(opts.expectedRPID).toBe('chat.example.com');
		expect(opts.expectedOrigin).toBe('https://chat.example.com');
		expect(opts.requireUserVerification).toBe(true);
		expect(opts.credential.id).toBe('c');
	});
});

describe('verifyRegistrationCeremony', () => {
	function fakeCookies() {
		const store = new Map<string, string>();
		const cookies = {
			get: (k: string) => store.get(k),
			set: (k: string, v: string) => store.set(k, v),
			delete: (k: string) => store.delete(k),
		} as unknown as Cookies;
		return { cookies, store };
	}
	function fakeRequest(body: unknown): Request {
		return { json: async () => body } as unknown as Request;
	}
	const registrationInfo = {
		credential: { id: 'cred-1', publicKey: new Uint8Array([9, 9]), counter: 7 },
		credentialBackedUp: true,
		credentialDeviceType: 'multiDevice' as const,
	};

	it('verifies, clears the challenge, and projects credential + filtered transports', async () => {
		verifyRegistrationResponseMock.mockResolvedValue({ verified: true, registrationInfo });
		const { cookies, store } = fakeCookies();
		setRegistrationChallengeCookie(cookies, 'the-challenge');
		const req = fakeRequest({
			response: { response: { transports: ['internal', 'bogus'] } },
			name: '  My Key  ',
		});

		const result = await verifyRegistrationCeremony(cookies, req);

		expect(result.credential.id).toBe('cred-1');
		expect(result.backedUp).toBe(true);
		expect(result.deviceType).toBe('multiDevice');
		expect(result.transports).toEqual(['internal']); // 'bogus' filtered out
		expect(result.body.name).toBe('  My Key  '); // raw, caller sanitizes
		// Challenge cookie is single-use — cleared regardless of outcome.
		expect(store.size).toBe(0);
		// The verified challenge was passed through to the SDK.
		expect(verifyRegistrationResponseMock.mock.calls[0][0].expectedChallenge).toBe('the-challenge');
	});

	it('throws 400 when the challenge cookie is missing', async () => {
		const { cookies } = fakeCookies();
		await expect(
			verifyRegistrationCeremony(cookies, fakeRequest({ response: {} })),
		).rejects.toMatchObject({ status: 400 });
	});

	it('throws 400 on a malformed JSON body', async () => {
		const { cookies } = fakeCookies();
		setRegistrationChallengeCookie(cookies, 'c');
		const req = {
			json: async () => {
				throw new Error('bad json');
			},
		} as unknown as Request;
		await expect(verifyRegistrationCeremony(cookies, req)).rejects.toMatchObject({ status: 400 });
	});

	it('throws 400 when the registration response is missing', async () => {
		const { cookies } = fakeCookies();
		setRegistrationChallengeCookie(cookies, 'c');
		await expect(
			verifyRegistrationCeremony(cookies, fakeRequest({ name: 'x' })),
		).rejects.toMatchObject({ status: 400 });
	});

	it('throws 400 when SimpleWebAuthn reports unverified', async () => {
		verifyRegistrationResponseMock.mockResolvedValue({ verified: false });
		const { cookies } = fakeCookies();
		setRegistrationChallengeCookie(cookies, 'c');
		await expect(
			verifyRegistrationCeremony(cookies, fakeRequest({ response: {} })),
		).rejects.toMatchObject({ status: 400 });
	});
});

describe('decodeUserHandle', () => {
	it('round-trips a UUID string through base64url', () => {
		const uuid = '11111111-2222-3333-4444-555555555555';
		const encoded = Buffer.from(uuid, 'utf8').toString('base64url');
		expect(decodeUserHandle(encoded)).toBe(uuid);
	});

	it('returns null for missing input', () => {
		expect(decodeUserHandle(undefined)).toBeNull();
		expect(decodeUserHandle(null)).toBeNull();
		expect(decodeUserHandle('')).toBeNull();
	});
});
