/**
 * `buildModelStatsReport` — joining the counters with the live listings and
 * config: unused vs retired, windowing, "used by" from last-use stamps,
 * favourites across users, and preset names only for the viewer's own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

import {
	buildModelStatsReport,
	parseModelStatsWindow,
	type EndpointListing,
} from '#lib/server/stats/model-stats-report.js';
import { recordModelEvent } from '#lib/server/stats/model-stats.js';
import { createCustomModel } from '#lib/server/db/queries/custom-models.js';
import { users } from '#lib/server/db/schema.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';
import type { ModelEntry, ModelStatsReport, ModelTaskRole } from '#lib/types/api.js';

let db: TestDB;
beforeEach(() => {
	db = createTestDb();
});
afterEach(() => closeTestDb());

const NOW = Date.UTC(2026, 9, 18, 12);
const DAY = 86_400_000;

function endpoint(id: string, local = false): LoadedEndpoint {
	return { id, displayName: id.toUpperCase(), local } as LoadedEndpoint;
}

function entry(
	endpointId: string,
	upstreamId: string,
	kind: ModelEntry['kind'] = 'chat',
): ModelEntry {
	return {
		id: `${endpointId}::${upstreamId}`,
		endpointId,
		upstreamId,
		displayName: `Pretty ${upstreamId}`,
		kind,
	} as ModelEntry;
}

function build(
	opts: {
		window?: '30d' | '90d' | 'all';
		viewer?: string;
		endpoints?: LoadedEndpoint[];
		listings?: EndpointListing[];
		roles?: Map<string, ModelTaskRole[]>;
	} = {},
): ModelStatsReport {
	return buildModelStatsReport({
		window: opts.window ?? '30d',
		viewerUserId: opts.viewer ?? 'nobody',
		endpoints: opts.endpoints ?? [endpoint('cloud'), endpoint('gpu', true)],
		listings: opts.listings ?? [
			{ endpointId: 'cloud', models: [entry('cloud', 'gpt'), entry('cloud', 'idle')], error: null },
			{ endpointId: 'gpu', models: [entry('gpu', 'qwen')], error: null },
		],
		roles: opts.roles ?? new Map<string, ModelTaskRole[]>(),
		now: NOW,
	});
}

const find = (r: ModelStatsReport, id: string) =>
	r.endpoints.flatMap((e) => e.models).find((m) => m.id === id);

describe('buildModelStatsReport', () => {
	it('puts local endpoints first and lists idle models with no counters', () => {
		const r = build();
		expect(r.endpoints.map((e) => e.id)).toEqual(['gpu', 'cloud']);
		expect(find(r, 'cloud::idle')).toMatchObject({
			listed: true,
			counts: {},
			displayName: 'Pretty idle',
		});
	});

	it('only counts days inside the window', () => {
		recordModelEvent('gpu::qwen', 'turn', { at: NOW - 5 * DAY });
		recordModelEvent('gpu::qwen', 'turn', { at: NOW - 60 * DAY });
		expect(find(build({ window: '30d' }), 'gpu::qwen')?.counts.turn).toBe(1);
		expect(find(build({ window: '90d' }), 'gpu::qwen')?.counts.turn).toBe(2);
		expect(build({ window: '30d' }).since).toBe('2026-09-19');
	});

	it('counts people by last use inside the window, but keeps last use from any time', () => {
		const a = seedUser();
		const b = seedUser();
		recordModelEvent('gpu::qwen', 'turn', { userId: a.id, at: NOW - DAY });
		recordModelEvent('gpu::qwen', 'turn', { userId: b.id, at: NOW - 100 * DAY });
		const m = find(build(), 'gpu::qwen')!;
		expect(m.usedBy).toBe(1);
		expect(m.lastUsedAt).toBe(NOW - DAY);
		expect(find(build({ window: 'all' }), 'gpu::qwen')?.usedBy).toBe(2);
	});

	it("counts a person who used it early on the window's first day, as the counters do", () => {
		const u = seedUser();
		// NOW is noon UTC; 29 days back is the window's first day.
		const firstDayMorning = Date.UTC(2026, 8, 19, 1);
		recordModelEvent('gpu::qwen', 'turn', { userId: u.id, at: firstDayMorning });
		const m = find(build(), 'gpu::qwen')!;
		expect(m.counts.turn).toBe(1);
		expect(m.usedBy).toBe(1);
	});

	it('reports the first day a model was counted, regardless of the window', () => {
		recordModelEvent('gpu::qwen', 'turn', { at: NOW - 200 * DAY });
		recordModelEvent('gpu::qwen', 'turn', { at: NOW });
		const r = build({ window: '30d' });
		expect(find(r, 'gpu::qwen')?.firstSeenDay).toBe('2026-04-01');
		expect(find(r, 'cloud::idle')?.firstSeenDay).toBeNull();
	});

	it("doesn't bring a model with only out-of-window history into a windowed report", () => {
		// Counted long ago, no last-use stamp (a task call, a reaction), no longer
		// listed: nothing about it belongs in a 30-day view.
		recordModelEvent('gone::old-embedder', 'task:embed', { at: NOW - 200 * DAY });
		const r = build({ window: '30d' });
		expect(find(r, 'gone::old-embedder')).toBeUndefined();
		expect(r.endpoints.map((e) => e.id)).not.toContain('gone');
		expect(find(build({ window: 'all' }), 'gone::old-embedder')).toBeDefined();
	});

	it('marks a counted model the endpoint no longer lists as retired', () => {
		recordModelEvent('gpu::old', 'turn', { at: NOW });
		expect(find(build(), 'gpu::old')).toMatchObject({ listed: false, displayName: 'old' });
	});

	it("doesn't call everything retired when a listing failed with nothing cached", () => {
		const r = build({
			listings: [
				{ endpointId: 'cloud', models: [], error: 'ECONNREFUSED' },
				{ endpointId: 'gpu', models: [entry('gpu', 'qwen')], error: null },
			],
		});
		expect(r.endpoints.find((e) => e.id === 'cloud')?.listingUnavailable).toBe(true);
		expect(r.endpoints.find((e) => e.id === 'gpu')?.listingUnavailable).toBe(false);
	});

	it('gives an endpoint gone from config its own section', () => {
		recordModelEvent('gone::m', 'turn', { at: NOW });
		const r = build();
		expect(r.endpoints.at(-1)).toMatchObject({ id: 'gone', removed: true });
	});

	it('includes configured task models, even unlisted ones', () => {
		const r = build({ roles: new Map([['gpu::embed', ['embeddings']]]) });
		expect(find(r, 'gpu::embed')).toMatchObject({ roles: ['embeddings'], listed: false });
	});

	it('counts favourites per person, a preset counting toward its base model', () => {
		const a = seedUser();
		const b = seedUser();
		const preset = createCustomModel({
			userId: b.id,
			name: 'Pirate',
			baseEndpointId: 'gpu',
			baseModelId: 'qwen',
		} as Parameters<typeof createCustomModel>[0]);
		db.update(users)
			.set({ preferencesJson: JSON.stringify({ favoriteModels: ['gpu::qwen'] }) })
			.where(eq(users.id, a.id))
			.run();
		db.update(users)
			.set({
				preferencesJson: JSON.stringify({ favoriteModels: [`custom::${preset.id}`, 'gpu::qwen'] }),
			})
			.where(eq(users.id, b.id))
			.run();
		expect(find(build(), 'gpu::qwen')?.favoritedBy).toBe(2);
	});

	it("names only the viewer's own presets", () => {
		const me = seedUser();
		const other = seedUser();
		const mine = createCustomModel({
			userId: me.id,
			name: 'Mine',
			baseEndpointId: 'gpu',
			baseModelId: 'qwen',
		} as Parameters<typeof createCustomModel>[0]);
		const theirs = createCustomModel({
			userId: other.id,
			name: 'Secret',
			baseEndpointId: 'gpu',
			baseModelId: 'qwen',
		} as Parameters<typeof createCustomModel>[0]);
		recordModelEvent('gpu::qwen', `preset_chat:${mine.id}`, { at: NOW });
		recordModelEvent('gpu::qwen', `preset_chat:${theirs.id}`, { at: NOW, count: 3 });
		recordModelEvent('gpu::qwen', 'preset_chat:deleted-one', { at: NOW });

		const presets = find(build({ viewer: me.id }), 'gpu::qwen')!.presets;
		expect(presets).toEqual([
			{ id: theirs.id, name: null, exists: true, chats: 3 },
			{ id: mine.id, name: 'Mine', exists: true, chats: 1 },
			{ id: 'deleted-one', name: null, exists: false, chats: 1 },
		]);
		// A preset counter is not a plain metric on the model.
		expect(Object.keys(find(build({ viewer: me.id }), 'gpu::qwen')!.counts)).toEqual([]);
	});
});

describe('parseModelStatsWindow', () => {
	it('defaults anything unknown to 30 days', () => {
		expect(parseModelStatsWindow('90d')).toBe('90d');
		expect(parseModelStatsWindow('all')).toBe('all');
		expect(parseModelStatsWindow('7d')).toBe('30d');
		expect(parseModelStatsWindow(null)).toBe('30d');
	});
});
