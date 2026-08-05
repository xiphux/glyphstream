/**
 * Resolution layer for the global `task_model` config slot — the model
 * used for utility tasks (title generation today; follow-up suggestions,
 * retrieval-query extraction, etc. in future). Lives separately from the
 * title generator so other task types can share the resolution.
 *
 * Resolution semantics (unset → null, unresolvable → null + one-time warning,
 * malformed → throw) are the shared `createModelResolver` contract.
 */

import { loadTaskModel, loadTaskModelConfig, type LoadedEndpoint } from '../endpoints/config';
import { createModelResolver } from '../endpoints/resolve-model';

export interface ResolvedTaskModel {
	endpoint: LoadedEndpoint;
	upstreamId: string;
}

// `task_model` is the one slot that's a bare string rather than a table, so the
// loaded "config" and the model id are the same value and there are no extra
// knobs to map on.
const resolver = createModelResolver<string, ResolvedTaskModel>({
	name: 'task-model',
	load: loadTaskModel,
	modelIdOf: (id) => id,
	build: (base) => base,
});

/**
 * Resolve the configured task model to an endpoint + upstream id. Memoized
 * on first access; returns null when `task_model` is unset OR when the
 * referenced endpoint isn't in the registry.
 */
export function getTaskModel(): ResolvedTaskModel | null {
	return resolver.get();
}

/**
 * Whether the configured task model is trusted with Private chat content
 * (`[task_model] private = true`). Gates whether a Private chat may be auto-titled
 * by it — titling ships the first exchange to the task model, which is a secondary
 * model unrelated to the chat's own, so a private chat only does it when the
 * operator has vouched for the task model. Memoized; false when task_model is
 * unset or configured in the bare-string form.
 */
export function isTaskModelPrivate(): boolean {
	if (privateCache) return privateCache.value;
	const value = loadTaskModelConfig()?.private ?? false;
	privateCache = { value };
	return value;
}
let privateCache: { value: boolean } | null = null;

/** Test/dev only: discard the cached resolution so the next access reloads. */
export function resetTaskModel(): void {
	resolver.reset();
	privateCache = null;
}
