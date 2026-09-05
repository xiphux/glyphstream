/**
 * Builds the read-only endpoint diagnostics snapshot behind `/settings/endpoints`.
 *
 * Three independent sources, joined here and nowhere else:
 *  - `registry.ts` — what the operator configured.
 *  - the model-list cache — reachability + how many models each one advertises,
 *    read WITHOUT triggering a fetch (see `getModelCacheEntry`).
 *  - the concurrency gate — what each resource group is actually doing right now.
 *
 * The gate is the authority on occupancy rather than the conversation in-flight
 * registry, because only three of the nine slot-acquiring paths register there
 * (the chat relay, the media relay, and the sync send path).
 * Reading the registry instead would render a title generation or a dreaming
 * sweep on a `max_concurrent = 1` box as an occupied endpoint with nothing named
 * against it — the exact confusion this page exists to remove.
 *
 * GROUPS are the outer structure, not endpoints, because the gate is. An
 * endpoint that never opted into a `resource_group` is its own group of one, so
 * the common case still renders as a flat list of endpoints; a shared-GPU pair
 * renders as one group with one cap and one queue, which is what it is.
 *
 * Nothing here spreads `LoadedEndpoint` — that type carries the resolved
 * `apiKey`, and a spread would put it on the wire the moment someone adds a
 * field. Every DTO field is written out by hand for that reason.
 */

import type {
	EndpointGroupStatus,
	EndpointSlotInfo,
	EndpointStatus,
	EndpointsStatusResponse,
	ModelKind,
} from '$lib/types/api';
import { MODEL_KINDS } from '$lib/types/api';
import { ConfigError, type LoadedEndpoint } from './config';
import { getResourceGroupSnapshot, type SlotSnapshot } from './concurrency';
import { getModelCacheEntry } from './list-models';
import { listEndpoints } from './registry';

function emptyByKind(): Record<ModelKind, number> {
	return Object.fromEntries(MODEL_KINDS.map((k) => [k, 0])) as Record<ModelKind, number>;
}

/**
 * How long a `modelId` may be before this view truncates it.
 *
 * Generous next to any real model id, and short enough that the field cannot
 * dominate a payload polled every three seconds.
 */
const MAX_MODEL_ID_CHARS = 128;

/**
 * The wire form of a gate record.
 *
 * `modelId` is the one field here that is not operator-authored: it comes from
 * the request, and the send path validates only that it parses as
 * `<endpointId>::<something>` with a known endpoint — the upstream half is
 * never checked against the catalogue. So any signed-in user can put arbitrary
 * text after the `::` and have it sit in this payload for as long as their slot
 * is held, which on a queued single-GPU box is a while. Svelte escapes it, so
 * this is not injection; it is a stranger writing on the operator's diagnostic
 * surface, which is read as trustworthy. Truncating bounds both the spoof and
 * the size of a 3s-polled response. Validating at the send route instead was
 * considered and rejected: a model that is genuinely available upstream but
 * missing from a stale catalogue would then fail to generate, which trades a
 * cosmetic problem for a functional one.
 */
function toSlotInfo(s: SlotSnapshot): EndpointSlotInfo {
	return {
		id: s.id,
		endpointId: s.endpointId,
		purpose: s.purpose,
		modelId: s.modelId === null ? null : s.modelId.slice(0, MAX_MODEL_ID_CHARS),
		since: s.since,
		state: s.state,
	};
}

function buildEndpoint(
	endpoint: LoadedEndpoint,
	groupActive: SlotSnapshot[],
	groupQueued: SlotSnapshot[],
): EndpointStatus {
	const cached = getModelCacheEntry(endpoint.id);
	const modelsByKind = emptyByKind();
	for (const m of cached?.models ?? []) modelsByKind[m.kind]++;

	// `degraded` needs both halves: a failed probe AND a model list from an
	// earlier successful one. The catch in `refreshInBackground` preserves the
	// prior models precisely so this distinction survives — without it a single
	// blipped /v1/models would report a working endpoint as down.
	const health = !cached
		? 'unknown'
		: cached.error === null
			? 'ok'
			: cached.models.length > 0
				? 'degraded'
				: 'down';

	return {
		id: endpoint.id,
		displayName: endpoint.displayName,
		baseUrl: endpoint.baseUrl,
		health,
		error: cached?.error ?? null,
		checkedAt: cached?.fetchedAt ?? null,
		latencyMs: cached?.durationMs ?? null,
		modelCount: cached?.models.length ?? 0,
		modelsByKind,
		active: groupActive.filter((s) => s.endpointId === endpoint.id).map(toSlotInfo),
		queued: groupQueued.filter((s) => s.endpointId === endpoint.id).map(toSlotInfo),
		maxConcurrent: Number.isFinite(endpoint.maxConcurrent) ? endpoint.maxConcurrent : null,
		requestTimeoutSeconds: endpoint.requestTimeoutSeconds,
		providerQuirk: endpoint.providerQuirk,
		supportsTools: endpoint.supportsTools,
		contextWindow: endpoint.contextWindow,
		hasApiKey: endpoint.apiKey !== null,
		releaseStrategy: endpoint.release,
	};
}

export function getEndpointsStatus(): EndpointsStatusResponse {
	const now = Date.now();

	let endpoints: LoadedEndpoint[];
	try {
		endpoints = listEndpoints();
	} catch (e) {
		// A bad config.toml is the single most likely reason an operator opens
		// this page, so it renders as a first-class state rather than a 500.
		if (e instanceof ConfigError) return { groups: [], configError: e.message, now };
		throw e;
	}

	// Preserve config order within a group, and order groups by where their
	// first member appears — so the page reads in the order the operator wrote
	// `config.toml`, not in Map-insertion or alphabetical order.
	const byGroup = new Map<string, LoadedEndpoint[]>();
	for (const ep of endpoints) {
		const members = byGroup.get(ep.resourceGroup);
		if (members) members.push(ep);
		else byGroup.set(ep.resourceGroup, [ep]);
	}

	const groups: EndpointGroupStatus[] = [];
	for (const [resourceGroup, members] of byGroup) {
		const snapshot = getResourceGroupSnapshot(resourceGroup);
		// Group-wide lists; `buildEndpoint` filters each to its own member. Named
		// apart from the group's `active`/`waiting` COUNTS below, which are the
		// gate's own totals and belong to the group rather than to any member.
		const groupHolders = snapshot?.holders ?? [];
		const groupQueued = snapshot?.queued ?? [];
		groups.push({
			resourceGroup,
			// A group with no gate yet has never been touched, so it is idle at its
			// CONFIGURED cap. Every member resolved the same group cap at config
			// load, so reading it off the first is not a coin flip.
			// Tested on the snapshot's PRESENCE, not on `max` being non-null: null is
			// a meaningful value here (unlimited), so `??` would silently fall
			// through to config for a group the gate has already answered for. The
			// two agree today — `gate.max` is seeded from this same config value —
			// but that is an invariant maintained elsewhere, not something this
			// expression should depend on.
			maxConcurrent: snapshot
				? snapshot.max
				: Number.isFinite(members[0].resourceGroupMaxConcurrent)
					? members[0].resourceGroupMaxConcurrent
					: null,
			active: snapshot?.active ?? 0,
			waiting: snapshot?.waiting ?? 0,
			evicting: snapshot?.evicting ?? false,
			lastHolderId: snapshot?.lastHolderId ?? null,
			endpoints: members.map((ep) => buildEndpoint(ep, groupHolders, groupQueued)),
		});
	}

	return { groups, configError: null, now };
}
