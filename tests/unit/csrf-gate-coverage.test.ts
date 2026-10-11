/**
 * Every state-changing route must sit behind the app's CSRF gate.
 *
 * SvelteKit's own origin check is switched off (`csrf.trustedOrigins: ['*']`
 * in sveltekit.config.ts — see the note there for why), which leaves the
 * Sec-Fetch-Site / Origin gate in hooks.server.ts as the only one. That gate
 * covers mutating methods under /api/ and nothing else. So a mutating handler
 * anywhere outside /api/, or a form action on any page, would take state
 * changes with no CSRF check at all — silently, since nothing else would fail.
 * This test is what turns that into a red build.
 *
 * If one is ever genuinely needed outside /api/, extend the gate's path test in
 * hooks.server.ts to cover it, then add it below with the reason.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES = join(__dirname, '../../src/routes');

/** Methods the gate refuses cross-site (STATE_MUTATING_METHODS), plus
 *  `fallback`, which answers whichever of them a route doesn't name. */
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE', 'fallback'];

function walk(dir: string, match: RegExp): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? walk(join(dir, e.name), match)
			: match.test(e.name)
				? [join(dir, e.name)]
				: [],
	);
}

const route = (file: string) => '/' + relative(ROUTES, join(file, '..')).split(sep).join('/');

describe('CSRF gate coverage', () => {
	it('has no mutating server handler outside /api/', () => {
		const names = MUTATING.join('|');
		// A declaration (`export const POST`, `export async function POST`) or an
		// export list (`export { handler as POST }`, `export { POST }`).
		const re = new RegExp(
			`export\\s+(?:const\\s+(?:${names})\\b|(?:async\\s+)?function\\s+(?:${names})\\b)` +
				`|export\\s*\\{[^}]*\\b(?:${names})\\b[^}]*\\}`,
		);
		const outside = walk(ROUTES, /^\+server\.(ts|js)$/)
			.filter((f) => !route(f).startsWith('/api/'))
			.filter((f) => re.test(readFileSync(f, 'utf8')))
			.map(route);
		expect(outside).toEqual([]);
	});

	it('has no form actions', () => {
		const withActions = walk(ROUTES, /^\+page\.server\.(ts|js)$/)
			.filter((f) => /export\s+const\s+actions\b/.test(readFileSync(f, 'utf8')))
			.map(route);
		expect(withActions).toEqual([]);
	});
});
