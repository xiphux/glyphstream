import { describe, expect, it, vi } from 'vitest';
import type { FeatureCategory } from '$lib/types/api';

// The seal enumerates the configured MCP server catalog to disable every
// `mcp:<id>`. Mock it so the test is independent of config.toml.
const listServerCatalogMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/mcp/registry', () => ({ listServerCatalog: listServerCatalogMock }));

import { resolveDisabledFeatures, sealPrivateFeatures } from '$lib/server/chat/private-seal';

function catalog(...ids: string[]) {
	listServerCatalogMock.mockReturnValue(
		ids.map((id) => ({
			id,
			displayName: id,
			transport: 'http' as const,
			auth: 'global' as const,
			toolCount: 0,
			available: true,
		})),
	);
}

describe('sealPrivateFeatures', () => {
	it('disables personalization, web, and both prompt-enhancement categories', () => {
		catalog();
		const sealed = sealPrivateFeatures([]);
		expect(sealed).toContain('personalization');
		expect(sealed).toContain('web');
		expect(sealed).toContain('image_prompt_enhancement');
		expect(sealed).toContain('video_prompt_enhancement');
	});

	it('disables every configured MCP server (mcp:<id>)', () => {
		catalog('github', 'fastmail');
		const sealed = sealPrivateFeatures([]);
		expect(sealed).toContain('mcp:github');
		expect(sealed).toContain('mcp:fastmail');
	});

	it('leaves code_interpreter and skills ENABLED (transient / static context-in)', () => {
		catalog('github');
		const sealed = sealPrivateFeatures([]);
		expect(sealed).not.toContain('code_interpreter');
		expect(sealed).not.toContain('skills');
	});

	it('preserves the conversation’s existing opt-outs and dedupes', () => {
		catalog('github');
		// `web` is already opted out on the base — must not appear twice.
		const base: FeatureCategory[] = ['web', 'code_interpreter'];
		const sealed = sealPrivateFeatures(base);
		expect(sealed.filter((c) => c === 'web')).toHaveLength(1);
		// A base opt-out we don't force (code_interpreter) still carries through.
		expect(sealed).toContain('code_interpreter');
	});
});

describe('resolveDisabledFeatures', () => {
	it('passes a non-private conversation’s opt-outs through verbatim', () => {
		catalog('github');
		const base: FeatureCategory[] = ['web'];
		// Same reference, unsealed — no MCP/personalization added.
		expect(resolveDisabledFeatures({ private: false, disabledFeatures: base })).toBe(base);
	});

	it('seals a private conversation (adds personalization + mcp, etc.)', () => {
		catalog('github');
		const sealed = resolveDisabledFeatures({ private: true, disabledFeatures: [] });
		expect(sealed).toContain('personalization');
		expect(sealed).toContain('mcp:github');
	});
});
