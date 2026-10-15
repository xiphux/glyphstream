import type { RequestEvent } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { describe, expect, it, vi } from 'vitest';
import { chainHandles } from '#lib/server/util/handle-chain.js';

const event = {} as RequestEvent;

describe('chainHandles', () => {
	it('runs hooks outermost first on the way in, and in reverse on the way out', async () => {
		const seen: string[] = [];
		const hook =
			(name: string): Handle =>
			async ({ event, resolve }) => {
				seen.push(`${name} in`);
				const res = await resolve(event);
				seen.push(`${name} out`);
				return res;
			};
		const resolve = vi.fn(async () => {
			seen.push('route');
			return new Response('ok');
		});
		await chainHandles(hook('a'), hook('b'))({ event, resolve });
		expect(seen).toEqual(['a in', 'b in', 'route', 'b out', 'a out']);
	});

	it('lets a hook answer without reaching the route', async () => {
		const resolve = vi.fn(async () => new Response('route'));
		const gate: Handle = () => new Response('no', { status: 403 });
		const res = await chainHandles(gate)({ event, resolve });
		expect(res.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('hands resolve options to the route, merged inner over outer', async () => {
		const resolve = vi.fn(async () => new Response('ok'));
		const outerPreload = () => true;
		const transformPageChunk = ({ html }: { html: string }) => html;
		await chainHandles(
			({ event, resolve }) => resolve(event, { preload: outerPreload }),
			({ event, resolve }) => resolve(event, { transformPageChunk }),
		)({ event, resolve });
		expect(resolve).toHaveBeenCalledWith(event, { preload: outerPreload, transformPageChunk });
	});
});
