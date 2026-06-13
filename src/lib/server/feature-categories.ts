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

export function getAllFeatureCategoryLabels(): FeatureCategoryEntry[] {
	const builtin: FeatureCategoryEntry[] = BUILTIN_FEATURE_CATEGORIES.map((id) => ({
		id,
		label: FEATURE_CATEGORY_LABELS[id].label,
		description: FEATURE_CATEGORY_LABELS[id].description,
		source: 'builtin',
	}));
	// Catalog-based (not per-user): every configured server is a toggle for
	// everyone. A per-user server's tools are only advertised/executed for
	// users who've supplied a credential, so toggling it without one is a
	// harmless no-op — and surfacing it hints the capability is available.
	const mcp: FeatureCategoryEntry[] = listServerCatalog()
		.filter((s) => s.available)
		.map((s) => {
			const perUser = s.auth === 'per_user';
			const noun = s.toolCount === 1 ? 'tool' : 'tools';
			// Per-user servers may have no known tool count until the user
			// connects, so describe them by capability rather than a stale 0.
			const description = perUser
				? `Tools from the "${s.displayName}" MCP server (connect your account in Settings → MCP servers).`
				: `Tools from the "${s.displayName}" MCP server (${s.toolCount} ${noun}).`;
			return { id: `mcp:${s.id}`, label: s.displayName, description, source: 'mcp' };
		});
	return [...builtin, ...mcp];
}

/**
 * Set of category ids that are currently registered (built-in or live
 * MCP). Used by the conversation-create seed and the custom-models
 * validator to silently drop / reject categories that point at MCP
 * servers no longer present in config.toml.
 */
export function getRegisteredCategoryIds(): Set<string> {
	return new Set(getAllFeatureCategoryLabels().map((c) => c.id));
}
