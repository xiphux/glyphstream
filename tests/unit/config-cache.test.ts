import { describe, expect, it, vi } from 'vitest';
import { memoizeConfig, resetConfigCachesForTests } from '#lib/server/util/config-cache.js';

describe('memoizeConfig', () => {
	it('loads once, and remembers a null', () => {
		const load = vi.fn(() => null);
		const get = memoizeConfig(load);
		expect(get()).toBeNull();
		expect(get()).toBeNull();
		expect(load).toHaveBeenCalledOnce();
	});

	it('does not remember a throw', () => {
		const load = vi
			.fn<() => number>()
			.mockImplementationOnce(() => {
				throw new Error('config mid-write');
			})
			.mockReturnValue(7);
		const get = memoizeConfig(load);
		expect(() => get()).toThrow('config mid-write');
		expect(get()).toBe(7);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('reloads after its own reset, and after a reset of every cache', () => {
		let n = 0;
		const a = memoizeConfig(() => ++n);
		const b = memoizeConfig(() => ++n);
		expect([a(), b()]).toEqual([1, 2]);
		a.reset();
		expect([a(), b()]).toEqual([3, 2]);
		resetConfigCachesForTests();
		expect([a(), b()]).toEqual([4, 5]);
	});
});
