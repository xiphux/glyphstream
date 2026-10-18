/**
 * The boot-time storage probe names an unwritable media/derived directory in
 * the log (with the chown fix) and stays quiet for a writable one.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeMediaDirsWritable } from '#lib/server/media/writable-probe.js';

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), 'gs-probe-'));
	dirs.push(d);
	return d;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) {
		chmodSync(d, 0o700);
		rmSync(d, { recursive: true, force: true });
	}
});

describe('probeMediaDirsWritable', () => {
	it('is silent for a writable directory and leaves nothing behind', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const dir = tmp();
		await probeMediaDirsWritable([['MEDIA_DIR', dir]]);
		expect(err).not.toHaveBeenCalled();
		expect(readdirSync(dir)).toEqual([]);
	});

	it.skipIf(process.getuid?.() === 0)(
		'names an unwritable directory once, with the chown fix',
		async () => {
			const err = vi.spyOn(console, 'error').mockImplementation(() => {});
			const dir = tmp();
			chmodSync(dir, 0o500);
			await probeMediaDirsWritable([
				['MEDIA_DIR', dir],
				['DERIVED_DIR', dir],
			]);
			expect(err).toHaveBeenCalledTimes(1);
			// The fix names the ids the process runs as — not the image's default
			// 1000, which is wrong under a compose `user:` override.
			const msg = String(err.mock.calls[0][0]);
			expect(msg).toMatch(/MEDIA_DIR .* not writable /s);
			expect(msg).toContain(`chown -R ${process.getuid!()}:${process.getgid!()} `);
		},
	);
});
