/**
 * Resolution layer for the `[memory_model]` config block — the capable model the
 * phase-4 memory-consolidation ("dreaming") worker uses to merge/reword/prune a
 * user's saved memories, plus the schedule fields the worker gates on.
 *
 * Deliberately a separate tier from `task_model`: merging facts without dropping
 * them needs a capable model, not the small utility model that titles chats.
 *
 * Resolution semantics (unset → null, unresolvable → null + one-time warning,
 * malformed → throw) are the shared `createModelResolver` contract. A null here
 * means the dreaming worker simply doesn't mount — boot must not crash on
 * misconfiguration.
 */

import { loadMemoryModelConfig, type LoadedEndpoint } from '../endpoints/config';
import { createModelResolver } from '../endpoints/resolve-model';

export interface ResolvedMemoryModel {
	endpoint: LoadedEndpoint;
	upstreamId: string;
	maxTokens: number;
	temperature: number;
	/** "HH:MM-HH:MM" quiet-hours window, or '' for always-open. */
	activeHours: string;
	/** IANA zone the window is interpreted in. */
	timezone: string;
	/** Char cap on the conversation-topics map — it rides in the system prompt every
	 *  personalization-on turn, so this is a per-turn token cost, not a one-off. */
	overviewMaxChars: number;
}

const resolver = createModelResolver({
	name: 'memory-model',
	load: loadMemoryModelConfig,
	modelIdOf: (cfg) => cfg.model,
	build: (base, cfg): ResolvedMemoryModel => ({
		...base,
		maxTokens: cfg.maxTokens,
		temperature: cfg.temperature,
		activeHours: cfg.activeHours,
		timezone: cfg.timezone,
		overviewMaxChars: cfg.overviewMaxChars,
	}),
});

/**
 * Resolve the configured memory model to an endpoint + upstream id + knobs +
 * schedule. Memoized on first access; returns null when `[memory_model]` is unset
 * OR the referenced endpoint isn't in the registry.
 */
export function getMemoryModel(): ResolvedMemoryModel | null {
	return resolver.get();
}

/** Test/dev only: discard the cached resolution so the next access reloads. */
export function resetMemoryModel(): void {
	resolver.reset();
}
