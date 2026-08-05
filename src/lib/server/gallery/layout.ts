/**
 * The gallery's layout + unit engine: it loads a user's whole filtered library,
 * stacks related media into units, buckets them into local-time days, and serves
 * the grid its scroll-height reservation and demand-loaded slices.
 *
 * Split out of `db/queries/media.ts`, which had grown to 1800 lines by absorbing
 * this alongside plain row access. The two are different things: everything in
 * `queries/media.ts` is a statement against the media table, while this is a
 * computation over the result — stacking, day bucketing, and the two caches that
 * make it affordable. A file named "queries" was not where anyone would look for
 * a memoized layout engine.
 *
 * Nothing here changed in the move; the caches, their bounds and their
 * fingerprint invalidation are as they were.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { media } from '../db/schema';
import {
	assignedConversationId,
	attachConversationTitles,
	getMediaListItemsByIds,
	listMediaForConversation,
} from '../db/queries/media';
import { groupGalleryItems, type StackableMedia } from '../../gallery-stacks';
import type {
	GalleryLayout,
	GalleryUnit,
	GalleryUnitsPage,
	MediaKind,
	MediaListItem,
} from '$lib/types/api';

type GalleryUnitOpts = {
	kind?: 'image' | 'video';
	model?: string;
	tzOffsetMinutes?: number;
	/** Whether to collapse related media into stacks (the gallery's default).
	 *  `false` = the "stacking off" firehose: every media row is its own solo
	 *  unit, so the unit count equals the media count. */
	stack?: boolean;
};

/** Lightweight row projection sufficient to run `groupGalleryItems` and build
 *  the thin `GalleryUnit`s. */
interface UnitSourceRow extends StackableMedia {
	kind: MediaKind;
	promptExcerpt: string | null;
}

/** Two-digit zero-pad for the local day key. */
function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local-time `YYYY-MM-DD` for an instant, shifting UTC by the viewer's offset
 *  (same single-offset approach as the periods query; the DST-boundary caveat is
 *  cosmetic and — because each unit carries this exact key and the client
 *  sections by it — never desyncs a section's reserved height from the units
 *  rendered into it). */
function localDayKey(ms: number, tzOffsetMin: number): string {
	const d = new Date(ms + tzOffsetMin * 60_000);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Load the whole filtered gallery library as lightweight rows, newest-first —
 *  the input to the server-side stacking pass. Mirrors listMediaForUser's
 *  gallery filter (generated, non-deleted, image/video, kind/model), minus
 *  pagination. */
function loadGalleryUnitSource(userId: string, opts: GalleryUnitOpts): UnitSourceRow[] {
	const db = getDb();
	const conditions = [
		eq(media.userId, userId),
		isNull(media.hardDeletedAt),
		eq(media.origin, 'generated'),
		opts.kind ? eq(media.kind, opts.kind) : inArray(media.kind, ['image', 'video']),
		opts.model ? eq(media.sourceModel, opts.model) : undefined,
	].filter(Boolean) as Parameters<typeof and>[number][];

	const rows = db
		.select({
			id: media.id,
			kind: media.kind,
			createdAt: media.createdAt,
			originalPrompt: media.originalPrompt,
			promptFull: media.promptFull,
			promptExcerpt: media.promptExcerpt,
			conversationId: assignedConversationId,
		})
		.from(media)
		.where(and(...conditions))
		.orderBy(desc(media.createdAt), desc(media.id))
		.all();

	return attachConversationTitles(
		userId,
		rows.map((r) => ({ ...r, conversationTitle: null as string | null })),
	);
}

/** One media row → a solo unit (the "stacking off" firehose path). */
function unitFromRow(r: UnitSourceRow, tz: number): GalleryUnit {
	return {
		key: r.id,
		groupKind: 'solo',
		leaderId: r.id,
		leaderKind: r.kind,
		createdAt: r.createdAt,
		dayKey: localDayKey(r.createdAt, tz),
		memberCount: 1,
		previews: [{ id: r.id, kind: r.kind }],
		excerpt: r.promptExcerpt,
		label: '',
		conversationId: r.conversationId,
		title: r.conversationTitle,
	};
}

/** One stacking group → a thin unit (leader-anchored, newest few previews). */
function unitFromGroup(
	g: ReturnType<typeof groupGalleryItems<UnitSourceRow>>[number],
	tz: number,
): GalleryUnit {
	const leader = g.items[0];
	return {
		key: g.key,
		groupKind: g.kind,
		leaderId: leader.id,
		leaderKind: leader.kind,
		createdAt: leader.createdAt,
		dayKey: localDayKey(leader.createdAt, tz),
		memberCount: g.items.length,
		previews: g.items.slice(0, 4).map((m) => ({ id: m.id, kind: m.kind })),
		excerpt: leader.promptExcerpt,
		// Stack label: conversation title, or the run's shared ORIGINAL prompt
		// (not the leader's enhanced excerpt, which describes only one image).
		label:
			g.kind === 'conversation'
				? (g.title ?? 'Untitled chat')
				: (leader.originalPrompt ?? leader.promptExcerpt ?? 'Untitled'),
		conversationId: g.conversationId,
		title: g.title,
	};
}

/** Run the shared stacking pass over the whole library and shape each group into
 *  a thin `GalleryUnit`, newest-first. This is the single source of truth the
 *  client's grid renders — identical grouping to the client's own
 *  `groupGalleryItems`, since it IS that function. With `stack: false` every row
 *  is a solo unit instead (the firehose view). */
function computeGalleryUnits(userId: string, opts: GalleryUnitOpts): GalleryUnit[] {
	const tz = Number.isFinite(opts.tzOffsetMinutes) ? (opts.tzOffsetMinutes as number) : 0;
	const rows = loadGalleryUnitSourceCached(userId, opts);
	if (opts.stack === false) return rows.map((r) => unitFromRow(r, tz));
	return groupGalleryItems(rows).map((g) => unitFromGroup(g, tz));
}

// --- Gallery unit-list cache -------------------------------------------------
// `computeGalleryUnits` loads + stacks the WHOLE filtered library, and the
// client's grid demand-pages it (one `/api/media/units` request per PAGE units).
// A full top-to-bottom scroll would otherwise re-run that O(library) pass once
// per page — O(library²) of work across the scroll. Memoize the computed list
// per (user, filter, tz) so all pages of one scroll — and the paired layout +
// first-units of a single reload — share one computation.
//
// Correctness: each entry is validated against a cheap per-user data fingerprint
// (a count of the user's generated media, live + total). Any insert or delete
// changes it, so the cache auto-invalidates on every write path — including
// direct DB writes that bypass the query layer (e.g. the e2e seed helpers) —
// with no manual invalidation calls to keep in sync. A short TTL backstops the
// residual case a count can't see (a link/unlink or conversation delete that
// re-homes stacking without changing the count).
//
// Bounded size: `model` and `tzOffsetMinutes` are part of the key and come from
// unvalidated query params, so key cardinality is client-controlled. Three
// things bound it in the single long-running Node process — `tzOffsetMinutes` is
// snapped to one of ~105 real offsets, a `model` that matches nothing is never
// cached, and the map evicts oldest-first on both an entry cap and a total-units
// cap (the entry cap alone bounds entries, not the memory behind them).
const GALLERY_UNITS_TTL_MS = 30_000;
const GALLERY_UNITS_CACHE_MAX = 256;
/** Total units held across all cache entries. Each entry holds a unit per item
 *  in the whole filtered library, so a count-only cap bounds the number of
 *  entries but not the memory behind them — 256 entries x a large library is
 *  gigabytes. Evict on whichever bound trips first. */
const GALLERY_UNITS_CACHE_MAX_UNITS = 200_000;
const galleryUnitsCache = new Map<
	string,
	{ fingerprint: string; expiresAt: number; units: GalleryUnit[] }
>();
let galleryUnitsCachedTotal = 0;

// The unit *source* — the O(library) load whose per-row correlated subquery
// resolves each item's assigned conversation — memoized separately from the
// computed units above.
//
// Two callers need it and only one of them wants units: the drill-in
// (`listGalleryUnitMembers`) needs a group's ordered member ids, which a
// `GalleryUnit` doesn't carry (it keeps <=4 previews and a count). It therefore
// used to re-run this load *and* a full re-stack on every drill-in click, with
// no cache at all — the single most expensive query in the app, on a routine
// user action.
//
// Keyed without `stack`/`tzOffsetMinutes`, which only affect how the rows are
// grouped and bucketed afterwards, so every variant shares one load.
const gallerySourceCache = new Map<
	string,
	{ fingerprint: string; expiresAt: number; rows: UnitSourceRow[]; chars: number }
>();
const GALLERY_SOURCE_CACHE_MAX = 64;
/** Total prompt characters held across all source entries — the same reasoning
 *  as `GALLERY_UNITS_CACHE_MAX_UNITS`, and it binds harder here. A stacked
 *  `GalleryUnit` keeps <=4 previews and a count, while a source row keeps every
 *  item's id, excerpt and *untruncated* `promptFull`, so 64 entries x a large
 *  library is worse than the units cache it sits next to. 20M chars is ~40MB of
 *  UTF-16 — roughly one 30k-item library's worth of prompts, so the common case
 *  caches whole and only a pathological one trims. */
const GALLERY_SOURCE_CACHE_MAX_CHARS = 20_000_000;
let gallerySourceCachedChars = 0;

/** Retained prompt text in one source row. Budgeting on characters rather than
 *  a row count (the units cache's bound) because these rows are dominated by
 *  `promptFull`, which is stored untruncated — an enhanced image prompt runs
 *  hundreds to a few thousand chars, so equal row counts can differ by an order
 *  of magnitude in bytes. Ids/timestamps are ignored: they're a rounding error
 *  next to the prompts, and the point is a ceiling, not an audit. */
function sourceRowChars(r: UnitSourceRow): number {
	return (
		(r.promptFull?.length ?? 0) +
		(r.originalPrompt?.length ?? 0) +
		(r.promptExcerpt?.length ?? 0) +
		(r.conversationTitle?.length ?? 0)
	);
}

function sourceRowsChars(rows: UnitSourceRow[]): number {
	let n = 0;
	for (const r of rows) n += sourceRowChars(r);
	return n;
}

function gallerySourceCacheKey(userId: string, opts: GalleryUnitOpts): string {
	return JSON.stringify([userId, opts.kind ?? '', opts.model ?? '']);
}

/** `loadGalleryUnitSource` behind the same fingerprint + TTL validation the unit
 *  cache uses. The returned array is shared read-only. */
function loadGalleryUnitSourceCached(userId: string, opts: GalleryUnitOpts): UnitSourceRow[] {
	const fingerprint = galleryUserFingerprint(userId);
	const key = gallerySourceCacheKey(userId, opts);
	const now = Date.now();
	const hit = gallerySourceCache.get(key);
	if (hit && hit.fingerprint === fingerprint && now < hit.expiresAt) {
		// Touch on access so eviction is genuinely by-recency. `Map.set` over an
		// existing key keeps its original position, so without the delete a hot
		// entry ages to the front and gets evicted ahead of colder ones. The
		// running char total is untouched — the entry stays resident, only its
		// position moves.
		gallerySourceCache.delete(key);
		gallerySourceCache.set(key, hit);
		return hit.rows;
	}
	const rows = loadGalleryUnitSource(userId, opts);
	// Don't cache an empty result. `model` reaches the key straight from an
	// unvalidated query param, and an unknown one matches no rows — so without
	// this, a client walking `model=1,2,3…` mints entries that evict the real
	// ones. A legitimate filter comes from the facet dropdown, which is built
	// from rows that exist; the false-negative (a filter whose last item was
	// just deleted) re-runs a scan that now matches nothing, which is cheap.
	if (rows.length === 0) {
		evictSourceEntry(key);
		return rows;
	}
	evictSourceEntry(key);
	// Store the char count with the entry rather than re-walking its rows at
	// eviction time: a TTL sweep can drop several full-library entries in one
	// pass, and that pass runs on a gallery request, on the single thread.
	const chars = sourceRowsChars(rows);
	gallerySourceCache.set(key, { fingerprint, expiresAt: now + GALLERY_UNITS_TTL_MS, rows, chars });
	gallerySourceCachedChars += chars;
	// Drop entries whose TTL has already passed. The TTL is otherwise only
	// checked on read, so a stale full-library array stays resident until its
	// exact key is asked for again — which, with a key space this small, may be
	// never.
	for (const [k, entry] of [...gallerySourceCache]) {
		if (k !== key && now >= entry.expiresAt) evictSourceEntry(k);
	}
	// Then evict oldest-first until both bounds hold.
	for (const oldest of [...gallerySourceCache.keys()]) {
		if (
			gallerySourceCache.size <= GALLERY_SOURCE_CACHE_MAX &&
			gallerySourceCachedChars <= GALLERY_SOURCE_CACHE_MAX_CHARS
		) {
			break;
		}
		if (oldest === key) continue;
		evictSourceEntry(oldest);
	}
	return rows;
}

/** Drop one source entry, keeping the char total in step. Refreshing an entry
 *  goes through this rather than `set`ting over the existing key, so the rewrite
 *  lands at the end of the map — see the touch-on-hit note above for why
 *  position matters. */
function evictSourceEntry(key: string): void {
	const existing = gallerySourceCache.get(key);
	if (!existing) return;
	gallerySourceCachedChars -= existing.chars;
	gallerySourceCache.delete(key);
}

/** Drop one units entry, keeping the unit total in step. */
function evictUnitsEntry(key: string): void {
	const existing = galleryUnitsCache.get(key);
	if (!existing) return;
	galleryUnitsCachedTotal -= existing.units.length;
	galleryUnitsCache.delete(key);
}

/** Cheap signature of a user's gallery-relevant media state. `total` (all
 *  generated rows, incl. tombstones) rises on insert; `live` (non-deleted) falls
 *  on delete — the pair changes on any insert/delete combination, and drops to
 *  0/0 when the rows are wiped (a test reset). A single aggregate count over the
 *  user's media — far cheaper than recomputing the unit list, though it scans the
 *  user's rows rather than being fully index-served. */
function galleryUserFingerprint(userId: string): string {
	const row = getDb()
		.select({
			total: sql<number>`count(*)`,
			live: sql<number>`coalesce(sum(case when ${media.hardDeletedAt} is null then 1 else 0 end), 0)`,
		})
		.from(media)
		.where(and(eq(media.userId, userId), eq(media.origin, 'generated')))
		.get();
	return `${row?.total ?? 0}:${row?.live ?? 0}`;
}

/**
 * Snap a client-supplied UTC offset to a real one: -720..+840 minutes (UTC-12 to
 * UTC+14), on a 15-minute step. Real zones are all multiples of 15.
 *
 * The sign is east-positive, matching what the routes actually receive — the
 * client sends `-getTimezoneOffset()` (see `gallery/+page.svelte`), and
 * `localDayKey` *adds* the offset before reading UTC parts. Clamping to the
 * `getTimezoneOffset()` sign instead truncates every zone east of UTC+12
 * (Auckland in DST +780, Chatham +825, Kiritimati +840), which files items
 * created just after local midnight under the previous day's header.
 *
 * Normalized here rather than at each route because the value is part of a cache
 * key, so its cardinality is the cache's cardinality. Unclamped, a client could
 * walk `tzOffset=1,2,3…` and mint an unbounded number of distinct keys, each
 * forcing a cold O(library) recompute and evicting a legitimate entry. Snapping
 * caps it at 105 possible values and costs nothing — no real client sends
 * anything else.
 */
function normalizeTzOffset(minutes: number | undefined): number | undefined {
	if (minutes == null || !Number.isFinite(minutes)) return undefined;
	const clamped = Math.max(-720, Math.min(840, minutes));
	return Math.round(clamped / 15) * 15;
}

function galleryUnitsCacheKey(userId: string, opts: GalleryUnitOpts): string {
	// JSON-encode the tuple so an arbitrary model id can't forge a key collision.
	return JSON.stringify([
		userId,
		opts.kind ?? '',
		opts.model ?? '',
		opts.stack === false ? 'flat' : 'stack',
		opts.tzOffsetMinutes ?? 0,
	]);
}

/** `computeGalleryUnits` behind the per-(user, filter, tz) memo above. The
 *  returned array is shared read-only — callers slice/read it, never mutate. */
function computeGalleryUnitsCached(userId: string, rawOpts: GalleryUnitOpts): GalleryUnit[] {
	// Normalize before the key is built AND before the units are computed, so the
	// cached day buckets match the offset the key claims.
	const opts: GalleryUnitOpts = {
		...rawOpts,
		tzOffsetMinutes: normalizeTzOffset(rawOpts.tzOffsetMinutes),
	};
	const fingerprint = galleryUserFingerprint(userId);
	const key = galleryUnitsCacheKey(userId, opts);
	const hit = galleryUnitsCache.get(key);
	if (hit && hit.fingerprint === fingerprint && Date.now() < hit.expiresAt) {
		// Touch on access — same by-recency reasoning as the source cache above.
		galleryUnitsCache.delete(key);
		galleryUnitsCache.set(key, hit);
		return hit.units;
	}
	const units = computeGalleryUnits(userId, opts);
	// Same anti-thrash rule as the source cache: an unknown `model` matches
	// nothing, so don't let forged keys occupy slots.
	if (units.length === 0) {
		evictUnitsEntry(key);
		return units;
	}
	// Delete before re-inserting so the refreshed entry lands at the *end* of the
	// map. `Map.set` over an existing key keeps its original position, which made
	// this FIFO-by-first-insert: a hot entry aged to the front, and when it was
	// the oldest the eviction loop below hit it and bailed without trimming
	// anything, leaving the total over budget.
	evictUnitsEntry(key);
	const now = Date.now();
	galleryUnitsCache.set(key, { fingerprint, expiresAt: now + GALLERY_UNITS_TTL_MS, units });
	galleryUnitsCachedTotal += units.length;
	// Shed expired entries, same as the source cache — this one holds the heavier
	// payload of the two (a unit per library item, each with its own dayKey string
	// and up to 4 preview objects) and has the larger key space, so leaving it to
	// the bounds alone keeps the most memory resident the longest.
	for (const [k, entry] of [...galleryUnitsCache]) {
		if (k !== key && now >= entry.expiresAt) evictUnitsEntry(k);
	}
	// Evict oldest-first until BOTH bounds hold. The entry count alone doesn't
	// bound memory (each entry is a unit per library item), and the unit total
	// alone would let a huge library evict everything down to one entry.
	for (const oldest of [...galleryUnitsCache.keys()]) {
		if (
			galleryUnitsCache.size <= GALLERY_UNITS_CACHE_MAX &&
			(galleryUnitsCachedTotal <= GALLERY_UNITS_CACHE_MAX_UNITS || galleryUnitsCache.size <= 1)
		) {
			break;
		}
		if (oldest === key) continue;
		evictUnitsEntry(oldest);
	}
	return units;
}

/**
 * Per-day unit counts for the whole filtered library, newest-first, plus the
 * total. The client reserves exact scroll height from this before streaming any
 * unit data.
 */
export function computeGalleryLayout(userId: string, opts: GalleryUnitOpts = {}): GalleryLayout {
	const units = computeGalleryUnitsCached(userId, opts);
	// Units are newest-first with monotonically non-increasing dayKeys, so a Map
	// keyed by day accumulates in newest-first order with each day contiguous.
	const byDay = new Map<string, number>();
	for (const u of units) byDay.set(u.dayKey, (byDay.get(u.dayKey) ?? 0) + 1);
	return {
		days: [...byDay.entries()].map(([key, count]) => ({ key, units: count })),
		totalUnits: units.length,
	};
}

/**
 * A contiguous slice of the newest-first unit stream, for the grid's demand
 * loader. Offset-paged (not cursor) because the client drives it by absolute
 * unit index derived from the layout counts, and — because conversation stacks
 * are global — the unit at any offset depends on every row newer than it, so the
 * stream can't be keyset-sliced at the DB anyway. The full list is computed via
 * `computeGalleryUnitsCached`, so all pages of one scroll (and the paired layout)
 * reuse a single O(library) pass instead of re-running it per page.
 */
export function listGalleryUnits(
	userId: string,
	opts: GalleryUnitOpts & { offset?: number; limit?: number } = {},
): GalleryUnitsPage {
	const all = computeGalleryUnitsCached(userId, opts);
	const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
	const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? 120), 500));
	return { units: all.slice(offset, offset + limit), total: all.length };
}

/**
 * The complete member set of one gallery unit, newest-first — for drilling into
 * a stack. A conversation key (a bare conversation id) delegates to the
 * authoritative per-conversation read; a prompt-run key (`p:<leaderId>`)
 * recomputes the stacking and materializes that run's members. A solo/unknown
 * key returns `[]` (nothing to drill into).
 */
export function listGalleryUnitMembers(
	userId: string,
	unitKey: string,
	opts: { kind?: 'image' | 'video'; model?: string } = {},
): MediaListItem[] {
	if (!unitKey.startsWith('p:')) {
		// Conversation stack — the key IS the conversation id.
		return listMediaForConversation(unitKey, userId, opts);
	}
	// Prompt (orphan) run: re-run the shared grouping and pull the matching run's
	// members, then materialize them as full MediaListItems in run order. The
	// source load is memoized (see loadGalleryUnitSourceCached) so a drill-in
	// shares the scroll's load instead of re-running the library-wide query; only
	// the grouping — one in-memory pass — repeats.
	const run = groupGalleryItems(loadGalleryUnitSourceCached(userId, opts)).find(
		(g) => g.key === unitKey,
	);
	if (!run) return [];
	const orderedIds = run.items.map((m) => m.id);
	const byId = new Map(getMediaListItemsByIds(userId, orderedIds).map((m) => [m.id, m]));
	return orderedIds.map((id) => byId.get(id)).filter((m): m is MediaListItem => m != null);
}
