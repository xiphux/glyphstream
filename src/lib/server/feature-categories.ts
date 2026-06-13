/**
 * Assemble the per-conversation feature-category list that the composer
 * UI consumes. Built-in categories ('web', 'personalization') come from
 * `$lib/types/api`; MCP-server categories (`mcp:<server-id>`) come from
 * the live MCP registry.
 *
 * Must run server-side — the MCP registry isn't exposed to the browser
 * bundle. The (app) layout loader awaits MCP readiness before calling
 * this and ships the result to every (app) page.
 */

import {
	BUILTIN_FEATURE_CATEGORIES,
	FEATURE_CATEGORY_LABELS,
	type FeatureCategoryEntry,
} from '$lib/types/api';
import { listServerCatalog } from './mcp/registry';

export type { FeatureCategoryEntry };

/**
 * Build the per-conversation feature-category list.
 *
 * Global MCP servers are toggles for everyone. Per-user servers are
 * user-specific: when `configuredPerUserServerIds` is provided (the composer
 * path), a per-user server is shown ONLY if the user has supplied a
 * credential — an unconfigured one would render a toggle that does nothing
 * (no tools advertised until a token exists), so we hide it; connecting is
 * done in Settings → MCP servers. When the set is omitted (validation
 * contexts — see `getRegisteredCategoryIds`), all per-user servers are
 * included so a custom model can legitimately reference one before the user
 * has connected it.
 */
export function getAllFeatureCategoryLabels(
	opts: { configuredPerUserServerIds?: ReadonlySet<string> } = {},
): FeatureCategoryEntry[] {
	const { configuredPerUserServerIds } = opts;
	const builtin: FeatureCategoryEntry[] = BUILTIN_FEATURE_CATEGORIES.map((id) => ({
		id,
		label: FEATURE_CATEGORY_LABELS[id].label,
		description: FEATURE_CATEGORY_LABELS[id].description,
		source: 'builtin',
	}));
	const mcp: FeatureCategoryEntry[] = listServerCatalog()
		.filter((s) => s.available)
		.filter(
			(s) =>
				s.auth !== 'per_user' ||
				!configuredPerUserServerIds ||
				configuredPerUserServerIds.has(s.id),
		)
		.map((s) => {
			const noun = s.toolCount === 1 ? 'tool' : 'tools';
			// Per-user servers carry no catalog tool count (it's per connection),
			// so describe them by capability rather than a stale "0 tools".
			const description =
				s.auth === 'per_user'
					? `Tools from the "${s.displayName}" MCP server (your account).`
					: `Tools from the "${s.displayName}" MCP server (${s.toolCount} ${noun}).`;
			return { id: `mcp:${s.id}`, label: s.displayName, description, source: 'mcp' };
		});
	return [...builtin, ...mcp];
}

/**
 * Set of category ids that are currently registered (built-in or configured
 * MCP). Used by the conversation-create seed and the custom-models validator
 * to silently drop / reject categories that point at MCP servers no longer
 * present in config.toml. Includes all per-user servers (no configured-set
 * filter) so validation stays tolerant of categories a user hasn't connected
 * yet.
 */
export function getRegisteredCategoryIds(): Set<string> {
	return new Set(getAllFeatureCategoryLabels().map((c) => c.id));
}
