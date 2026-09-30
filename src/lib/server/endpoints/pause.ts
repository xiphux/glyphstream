/**
 * Persisted endpoint pauses — the durable half of `setResourceGroupPaused`.
 *
 * The gate holds the live flag; this keeps it in the database so a pause
 * outlives the process. That matters for the case the feature exists for: an
 * operator upgrading the whole stack pauses the image endpoint, recreates the
 * containers, and must find it still paused when GlyphStream comes back — not
 * granting generations onto a backend that isn't up yet.
 *
 * The set is read from the database once, lazily, on the first gate created —
 * never at module load, because the server entry must not open the database at
 * boot (see `adminBootstrapChecked` in hooks.server.ts). After that it is kept
 * in step by `pauseResourceGroup`, the only writer.
 */
import {
	listPausedResourceGroups,
	setResourceGroupPausedRow,
} from '../db/queries/paused-resource-groups';
import { setPausedResourceGroupSource, setResourceGroupPaused } from './concurrency';
import type { LoadedEndpoint } from './config';

let paused: Set<string> | null = null;

function pausedGroups(): Set<string> {
	paused ??= new Set(listPausedResourceGroups());
	return paused;
}

/** Point the gate at the persisted set. Called once from the server entry. */
export function installPersistedPauses(): void {
	setPausedResourceGroupSource((group) => pausedGroups().has(group));
}

/** Pause or resume `endpoint`'s resource group, durably. Store first, gate
 *  second: a failed write leaves the gate as it was, rather than a live pause
 *  that silently evaporates on the next restart. */
export function pauseResourceGroup(endpoint: LoadedEndpoint, pause: boolean): void {
	setResourceGroupPausedRow(endpoint.resourceGroup, pause);
	if (pause) pausedGroups().add(endpoint.resourceGroup);
	else pausedGroups().delete(endpoint.resourceGroup);
	setResourceGroupPaused(endpoint, pause);
}

/** Test-only: forget the cached set, as a fresh process would. */
export function resetPersistedPausesForTests(): void {
	paused = null;
}
