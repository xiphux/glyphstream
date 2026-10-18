/**
 * The read side of the model stats: the report behind `/settings/model-stats`.
 *
 * Joins three things that each know part of the answer — the counters (what
 * happened), the endpoints' live model listings (what exists now, so a model
 * nobody touched shows up as unused and one no longer offered as retired), and
 * config (which models hold a background job, and so aren't idle however few
 * chats they see).
 *
 * Admin-only and aggregate-only. Two reads here cross users — favourites from
 * every user's preferences, and preset ownership — and both reduce to counts;
 * the only preset NAMES returned are the viewer's own.
 */
import { gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '#lib/server/db/client.js';
import { customModels, modelStatsDaily, modelUserUsage, users } from '#lib/server/db/schema.js';
import { parseUserPreferences } from '#lib/server/db/queries/user-preferences.js';
import type { LoadedEndpoint } from '#lib/server/endpoints/config.js';
import { formatModelId, parseModelId } from '#lib/server/endpoints/model-id.js';
import { getTaskModel } from '#lib/server/tasks/task-model.js';
import { getMemoryModel } from '#lib/server/tasks/memory-model.js';
import { getImageEnhancerModel } from '#lib/server/tasks/image-enhancer-model.js';
import { resolveRelevanceConfig } from '#lib/server/retrieval/embeddings-config.js';
import { resolveRerankConfig } from '#lib/server/retrieval/rerank-config.js';
import { statsDay } from './model-stats';
import type {
	ModelEntry,
	ModelStatsEndpoint,
	ModelStatsModel,
	ModelStatsPreset,
	ModelStatsReport,
	ModelStatsWindow,
	ModelTaskRole,
} from '#lib/types/api.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS: Record<ModelStatsWindow, number | null> = { '30d': 30, '90d': 90, all: null };

export function parseModelStatsWindow(raw: string | null): ModelStatsWindow {
	return raw === '90d' || raw === 'all' ? raw : '30d';
}

/** One endpoint's listing, as `listAllModelsWithErrors` returns it. */
export interface EndpointListing {
	endpointId: string;
	models: ModelEntry[];
	error: string | null;
}

/** Which configured job each model holds, keyed by `endpoint::upstream`. */
export function configuredModelRoles(): Map<string, ModelTaskRole[]> {
	const roles = new Map<string, ModelTaskRole[]>();
	const add = (
		endpointId: string | undefined,
		upstreamId: string | undefined,
		role: ModelTaskRole,
	) => {
		if (!endpointId || !upstreamId) return;
		const id = formatModelId(endpointId, upstreamId);
		roles.set(id, [...(roles.get(id) ?? []), role]);
	};
	const task = getTaskModel();
	add(task?.endpoint.id, task?.upstreamId, 'title');
	const memory = getMemoryModel();
	add(memory?.endpoint.id, memory?.upstreamId, 'memory');
	const enhancer = getImageEnhancerModel();
	add(enhancer?.endpoint.id, enhancer?.upstreamId, 'enhance');
	const embeddings = resolveRelevanceConfig();
	add(embeddings?.endpoint.id, embeddings?.modelId, 'embeddings');
	const rerank = resolveRerankConfig();
	add(rerank?.endpoint.id, rerank?.modelId, 'rerank');
	return roles;
}

export interface BuildReportInput {
	window: ModelStatsWindow;
	viewerUserId: string;
	endpoints: readonly LoadedEndpoint[];
	listings: readonly EndpointListing[];
	roles: Map<string, ModelTaskRole[]>;
	now?: number;
}

export function buildModelStatsReport(input: BuildReportInput): ModelStatsReport {
	const now = input.now ?? Date.now();
	const days = WINDOW_DAYS[input.window];
	const sinceMs = days === null ? null : now - (days - 1) * DAY_MS;
	const since = sinceMs === null ? null : statsDay(sinceMs);
	const db = getDb();

	// Every model the report mentions, by stored id, created on first sight.
	const models = new Map<string, ModelStatsModel>();
	const modelFor = (id: string): ModelStatsModel | null => {
		const existing = models.get(id);
		if (existing) return existing;
		const parsed = parseModelId(id);
		if (!parsed) return null;
		const m: ModelStatsModel = {
			id,
			upstreamId: parsed.upstreamId,
			displayName: parsed.upstreamId,
			kind: null,
			listed: false,
			roles: input.roles.get(id) ?? [],
			counts: {},
			sums: {},
			usedBy: 0,
			lastUsedAt: null,
			favoritedBy: 0,
			presets: [],
		};
		models.set(id, m);
		return m;
	};

	// What exists now. An endpoint whose listing failed contributes whatever it
	// last listed successfully (the cache keeps that) — and if that's nothing,
	// it's flagged rather than having every model it ever served called retired.
	const listingByEndpoint = new Map(input.listings.map((l) => [l.endpointId, l]));
	for (const listing of input.listings) {
		for (const entry of listing.models) {
			const m = modelFor(entry.id);
			if (!m) continue;
			m.displayName = entry.displayName;
			m.kind = entry.kind;
			m.listed = true;
		}
	}

	// Configured roles name models that may not be listed (an embeddings model
	// a chat-oriented /models omits); they still belong on the page.
	for (const id of input.roles.keys()) modelFor(id);

	// Presets are resolved as their counters arrive.
	const presetCounts: Array<{ model: ModelStatsModel; presetId: string; chats: number }> = [];

	const counters = db
		.select({
			endpointId: modelStatsDaily.endpointId,
			modelId: modelStatsDaily.modelId,
			metric: modelStatsDaily.metric,
			count: sql<number>`sum(${modelStatsDaily.count})`,
			sum: sql<number>`sum(${modelStatsDaily.sum})`,
		})
		.from(modelStatsDaily)
		.where(since === null ? undefined : gte(modelStatsDaily.day, since))
		.groupBy(modelStatsDaily.endpointId, modelStatsDaily.modelId, modelStatsDaily.metric)
		.all();
	for (const r of counters) {
		const m = modelFor(formatModelId(r.endpointId, r.modelId));
		if (!m) continue;
		if (r.metric.startsWith('preset_chat:')) {
			presetCounts.push({
				model: m,
				presetId: r.metric.slice('preset_chat:'.length),
				chats: r.count,
			});
			continue;
		}
		m.counts[r.metric] = r.count;
		if (r.sum) m.sums[r.metric] = r.sum;
	}

	// A user whose LAST use falls in the window used it in the window — which is
	// all "used by N" needs, from one row per (model, user).
	const usage = db
		.select({
			endpointId: modelUserUsage.endpointId,
			modelId: modelUserUsage.modelId,
			lastUsedAt: sql<number>`max(${modelUserUsage.lastUsedAt})`,
			usedBy:
				sinceMs === null
					? sql<number>`count(*)`
					: sql<number>`sum(${modelUserUsage.lastUsedAt} >= ${sinceMs})`,
		})
		.from(modelUserUsage)
		.groupBy(modelUserUsage.endpointId, modelUserUsage.modelId)
		.all();
	for (const r of usage) {
		const m = modelFor(formatModelId(r.endpointId, r.modelId));
		if (!m) continue;
		m.lastUsedAt = r.lastUsedAt;
		m.usedBy = r.usedBy ?? 0;
	}

	resolvePresets(presetCounts, input.viewerUserId);
	countFavorites(modelFor);

	const configured = new Set(input.endpoints.map((e) => e.id));
	const byEndpoint = new Map<string, ModelStatsModel[]>();
	for (const m of models.values()) {
		const endpointId = parseModelId(m.id)!.endpointId;
		byEndpoint.set(endpointId, [...(byEndpoint.get(endpointId) ?? []), m]);
	}

	const endpoints: ModelStatsEndpoint[] = input.endpoints.map((e) => {
		const listing = listingByEndpoint.get(e.id);
		return {
			id: e.id,
			displayName: e.displayName,
			local: e.local ?? false,
			removed: false,
			listingUnavailable: !listing || (listing.error !== null && listing.models.length === 0),
			models: sortModels(byEndpoint.get(e.id) ?? []),
		};
	});
	// Local first (where an idle model costs disk), config order within each.
	endpoints.sort((a, b) => Number(b.local) - Number(a.local));
	for (const [id, ms] of byEndpoint) {
		if (configured.has(id)) continue;
		endpoints.push({
			id,
			displayName: id,
			local: false,
			removed: true,
			listingUnavailable: false,
			models: sortModels(ms),
		});
	}

	return { window: input.window, since, endpoints };
}

/** Busiest first, so the models doing the work lead each endpoint. */
function sortModels(ms: ModelStatsModel[]): ModelStatsModel[] {
	const activity = (m: ModelStatsModel) =>
		(m.counts.turn ?? 0) +
		(m.counts.error ?? 0) +
		(m.counts.generated ?? 0) +
		(m.counts.failed ?? 0);
	return ms.sort((a, b) => activity(b) - activity(a) || a.displayName.localeCompare(b.displayName));
}

function resolvePresets(
	counts: Array<{ model: ModelStatsModel; presetId: string; chats: number }>,
	viewerUserId: string,
): void {
	if (counts.length === 0) return;
	const rows = getDb()
		.select({ id: customModels.id, userId: customModels.userId, name: customModels.name })
		.from(customModels)
		.where(
			inArray(
				customModels.id,
				counts.map((c) => c.presetId),
			),
		)
		.all();
	const byId = new Map(rows.map((r) => [r.id, r]));
	for (const c of counts) {
		const row = byId.get(c.presetId);
		const preset: ModelStatsPreset = {
			id: c.presetId,
			name: row && row.userId === viewerUserId ? row.name : null,
			exists: row !== undefined,
			chats: c.chats,
		};
		c.model.presets.push(preset);
	}
	for (const c of counts) c.model.presets.sort((a, b) => b.chats - a.chats);
}

/**
 * "Favourited by N people", from each user's favourite-models preference. A
 * favourited preset counts toward its base model — the preset is how that
 * person uses the model. Counted once per person per model.
 */
function countFavorites(modelFor: (id: string) => ModelStatsModel | null): void {
	const db = getDb();
	const perUser = db
		.select({ prefs: users.preferencesJson })
		.from(users)
		.where(isNotNull(users.preferencesJson))
		.all()
		.map((r) => parseUserPreferences(r.prefs).favoriteModels)
		.filter((favs) => favs.length > 0);
	if (perUser.length === 0) return;

	const presetIds = [
		...new Set(
			perUser.flat().flatMap((f) => (f.startsWith('custom::') ? [f.slice('custom::'.length)] : [])),
		),
	];
	const presetBase = new Map(
		presetIds.length === 0
			? []
			: db
					.select({
						id: customModels.id,
						endpointId: customModels.baseEndpointId,
						modelId: customModels.baseModelId,
					})
					.from(customModels)
					.where(inArray(customModels.id, presetIds))
					.all()
					.map((r) => [r.id, formatModelId(r.endpointId, r.modelId)]),
	);

	for (const favs of perUser) {
		const ids = new Set(
			favs.flatMap((f) => {
				if (!f.startsWith('custom::')) return [f];
				const base = presetBase.get(f.slice('custom::'.length));
				return base ? [base] : [];
			}),
		);
		for (const id of ids) {
			const m = modelFor(id);
			if (m) m.favoritedBy++;
		}
	}
}
