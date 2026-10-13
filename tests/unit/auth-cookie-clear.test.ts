/**
 * Auth cookies must be cleared with the same `secure` attribute they were set
 * with. SvelteKit's `cookies.delete` fills unspecified attributes from its own
 * defaults, whose `secure` is true outside dev for any host but `localhost`; on
 * a plain-http deployment reached by IP the browser then ignores the clearing
 * cookie, so logout keeps the session cookie and single-use passkey / OAuth
 * cookies outlive the step that consumed them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import type { Cookies } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAuthCookie } from '#lib/server/auth/signed-cookies.js';

const original = process.env.EXTERNAL_BASE_URL;
afterEach(() => {
	if (original === undefined) delete process.env.EXTERNAL_BASE_URL;
	else process.env.EXTERNAL_BASE_URL = original;
});

function recordingCookies() {
	const deletes: Array<{ name: string; opts: Record<string, unknown> }> = [];
	const cookies = {
		delete: (name: string, opts: Record<string, unknown>) => deletes.push({ name, opts }),
	} as unknown as Cookies;
	return { cookies, deletes };
}

describe('clearAuthCookie', () => {
	it.each([
		['http://192.168.1.20:3000', false],
		['https://chat.example.com', true],
	])('clears with secure matching EXTERNAL_BASE_URL %s', (base, secure) => {
		process.env.EXTERNAL_BASE_URL = base;
		const { cookies, deletes } = recordingCookies();
		clearAuthCookie(cookies, 'glyphstream_session');
		expect(deletes).toEqual([
			{
				name: 'glyphstream_session',
				opts: { path: '/', httpOnly: true, sameSite: 'lax', secure },
			},
		]);
	});
});

describe('no bare cookies.delete in server code', () => {
	it('routes every cookie deletion through clearAuthCookie', () => {
		const root = join(import.meta.dirname, '../../src');
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, e.name);
				if (e.isDirectory()) walk(full);
				else if (/\.(ts|svelte)$/.test(e.name) && !full.endsWith('auth/signed-cookies.ts')) {
					if (/cookies\.delete\(/.test(readFileSync(full, 'utf8')))
						offenders.push(relative(root, full));
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});
