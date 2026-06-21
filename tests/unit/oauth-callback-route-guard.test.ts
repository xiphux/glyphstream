/**
 * Unit tests for the generic /api/auth/oauth/[provider]/callback route's
 * guard. It must 404 for unknown providers and — critically — for github,
 * whose callback lives at the legacy /api/auth/github/callback path and must
 * never be double-served here. For a provider whose registered callbackPath
 * matches this route, it delegates to the shared handler.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, type Cookies } from '@sveltejs/kit';

const getProviderMock = vi.fn();
const handleOAuthCallbackMock = vi.fn();

vi.mock('$lib/server/auth/oauth/registry', () => ({
	getProvider: (id: string) => getProviderMock(id),
}));
vi.mock('$lib/server/auth/oauth/callback-handler', () => ({
	handleOAuthCallback: (...args: unknown[]) => handleOAuthCallbackMock(...args),
}));

import { GET } from '../../src/routes/api/auth/oauth/[provider]/callback/+server';

function mkEvent(provider: string) {
	return {
		url: new URL(`http://localhost:5173/api/auth/oauth/${provider}/callback?code=c&state=s`),
		cookies: {} as Cookies,
		locals: { user: null },
		params: { provider },
	};
}

async function expectHttpError(fn: () => unknown, status: number) {
	try {
		await fn();
		throw new Error('expected an HttpError, none thrown');
	} catch (e) {
		if (isHttpError(e)) {
			expect(e.status).toBe(status);
			return;
		}
		throw e;
	}
}

beforeEach(() => {
	getProviderMock.mockReset();
	handleOAuthCallbackMock.mockReset();
});

describe('generic OAuth callback route — guard', () => {
	it('404s for an unknown provider', async () => {
		getProviderMock.mockReturnValue(null);
		await expectHttpError(() => GET(mkEvent('facebook') as never), 404);
		expect(handleOAuthCallbackMock).not.toHaveBeenCalled();
	});

	it('404s for github (its callbackPath is the legacy path, not this route)', async () => {
		getProviderMock.mockReturnValue({
			id: 'github',
			callbackPath: '/api/auth/github/callback',
		});
		await expectHttpError(() => GET(mkEvent('github') as never), 404);
		expect(handleOAuthCallbackMock).not.toHaveBeenCalled();
	});

	it('delegates to the shared handler when the callbackPath matches this route', async () => {
		const provider = { id: 'google', callbackPath: '/api/auth/oauth/google/callback' };
		getProviderMock.mockReturnValue(provider);
		handleOAuthCallbackMock.mockResolvedValue(undefined);

		await GET(mkEvent('google') as never);

		expect(handleOAuthCallbackMock).toHaveBeenCalledTimes(1);
		expect(handleOAuthCallbackMock.mock.calls[0][0]).toBe(provider);
	});
});
