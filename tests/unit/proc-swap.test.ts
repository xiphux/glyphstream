/**
 * Parsing of `/proc/self/status`'s VmSwap line.
 *
 * Small surface, but the two failure modes both produce a number the debug
 * panel would print without complaint:
 *
 *   - Reporting kB as though it were bytes understates swap by 1024x, which
 *     turns "64 MB of this process is on disk" into "0 MB" — the exact reading
 *     that clears swap as a suspect and sends the reader after the page cache.
 *   - Matching VmSwap's line loosely picks up a neighbour. `VmSize`, `VmSwap`
 *     and half a dozen others share the prefix and the units, so a regex
 *     anchored carelessly reports the process's whole address space as swap.
 *
 * Both are wrong in the direction that misleads rather than the direction that
 * looks broken, which is what makes them worth a test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readFileSync: vi.fn<(...a: unknown[]) => unknown>() }));
vi.mock('node:fs', () => ({ readFileSync: (...a: unknown[]) => mocks.readFileSync(...a) }));

const { swapBytes } = await import('../../src/lib/server/util/proc-swap');

/** A realistic excerpt, with the neighbours a loose match would catch. */
const STATUS = [
	'Name:\tnode',
	'VmPeak:\t 1240184 kB',
	'VmSize:\t 1180212 kB',
	'VmLck:\t       0 kB',
	'VmHWM:\t  204800 kB',
	'VmRSS:\t   90112 kB',
	'VmData:\t  512000 kB',
	'VmSwap:\t   65536 kB',
	'Threads:\t11',
].join('\n');

afterEach(() => {
	mocks.readFileSync.mockReset();
});

describe('swapBytes', () => {
	it('converts VmSwap from kB to bytes', () => {
		mocks.readFileSync.mockReturnValue(STATUS);
		// 65536 kB is 64 MiB. Asserting the byte figure rather than the kB one is
		// the whole point: the panel formats bytes, so a unit slip here renders as
		// a plausible small number instead of an obviously broken one.
		expect(swapBytes()).toBe(64 * 1_048_576);
	});

	it('anchors to the start of a line, not to a substring of one', () => {
		// Distinct from the case above, which a line-anchored AND an unanchored
		// pattern both pass on a realistic file. Here the decoy is a SUFFIX match:
		// an unanchored /VmSwap:\s+(\d+)\s+kB/ finds it inside `NonVmSwap:` and
		// reports 999999 kB, and nothing downstream would question a large number.
		mocks.readFileSync.mockReturnValue(
			['Name:\tnode', 'NonVmSwap:\t  999999 kB', 'VmSwap:\t   65536 kB'].join('\n'),
		);
		expect(swapBytes()).toBe(64 * 1_048_576);
	});

	it('reports a fully-resident process as 0 rather than as unavailable', () => {
		// The distinction the panel leans on: 0 is a finding ("reclaimed memory was
		// page cache"), null means the host could not be measured and the row is
		// dropped. Collapsing them would make an unmeasurable host look healthy.
		mocks.readFileSync.mockReturnValue('Name:\tnode\nVmSwap:\t       0 kB\n');
		expect(swapBytes()).toBe(0);
	});

	it('returns null when the field is absent', () => {
		// Kernels without swap accounting omit the line entirely.
		mocks.readFileSync.mockReturnValue('Name:\tnode\nVmRSS:\t   90112 kB\n');
		expect(swapBytes()).toBeNull();
	});

	it('returns null off Linux instead of throwing into the request path', () => {
		// /proc/self/status does not exist on macOS, and this runs inside the
		// response-header path — an uncaught ENOENT here would fail the request
		// rather than drop a debug row.
		mocks.readFileSync.mockImplementation(() => {
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});
		expect(swapBytes()).toBeNull();
	});
});
