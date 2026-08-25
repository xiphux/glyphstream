/**
 * How much of this process has been pushed to swap.
 *
 * The debug panel can already tell that a cold request spent its time WAITING
 * rather than working — `cpu` far under `ssr`, with major faults to match. What
 * it cannot say is where the memory was fetched back FROM, and the two answers
 * have different fixes:
 *
 *   - Clean file-backed pages (the mapped database, the executable) evicted from
 *     the page cache. Reclaiming them was free and refilling them is one read
 *     off the volume. Mostly a fact of life on a shared box; widening
 *     `mmap_size` puts MORE of the database in this category on purpose.
 *
 *   - Anonymous memory (the JS heap, SQLite's `cache_size` pages) written out to
 *     swap. Reclaiming it cost a write and recovering it costs a read, and on a
 *     NAS that swap lives on the same spinning volume the database is on. This
 *     is the one worth acting on — by shrinking the anonymous footprint, or by
 *     reserving memory for the container so the host stops choosing it.
 *
 * Major faults count both, so the counter alone cannot choose. `VmSwap` names
 * the second directly. Read it as a level, not a delta: it is how much of this
 * process is *currently* swapped out, so a nonzero reading on a slow request
 * means the process had been swapped and the request paid to bring some of it
 * back. Zero across several slow readings sends you to the page cache instead.
 *
 * Linux-only, by design and not by accident — `/proc/self/status` does not exist
 * on macOS, and there is no portable equivalent worth shimming, so this returns
 * null in local development and the panel drops the row. That is the same way
 * every other host-dependent field in the panel degrades.
 */
import { readFileSync } from 'node:fs';

/** Bytes of this process currently swapped out, or null where unavailable. */
export function swapBytes(): number | null {
	try {
		// Not cached: the whole point is that this moves between requests, and
		// it's a single small read from a synthetic file with no disk behind it.
		const status = readFileSync('/proc/self/status', 'utf8');
		// `VmSwap:\t     123 kB` — always kB on Linux regardless of page size,
		// so the unit is fixed rather than something to parse out.
		const match = /^VmSwap:\s+(\d+)\s+kB$/m.exec(status);
		if (match === null) return null;
		return Number(match[1]) * 1024;
	} catch {
		// Not Linux, or /proc not mounted in this container.
		return null;
	}
}
