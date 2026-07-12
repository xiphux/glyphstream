/**
 * Prefix stability: two consecutive turns that a user would call identical must
 * produce a byte-identical system prompt + `tools[]`.
 *
 * This is not a micro-optimization. Upstreams (llama.cpp, vLLM, the commercial
 * APIs) reuse a KV cache for the longest common token PREFIX, so a payload that
 * changes near the front re-prefills the entire conversation. And a `tools[]`
 * that changes between turns isn't just slow — the model's advertised
 * capabilities visibly come and go, which is a correctness problem in its own
 * right.
 *
 * The distinction that matters is asked-for vs. gratuitous. A user enabling a
 * skill, or the model calling save_memory, SHOULD change the payload. A server
 * whose handshake took 2.6 seconds instead of 2.4, or two skills that happen to
 * share a `created_at` millisecond, should not.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildUserMcpToolDefinitions } from '$lib/server/mcp/tool-bridge';
import { collapseSupersededSkillActivations } from '$lib/server/endpoints/serialize-upstream';
import type { UserServerState } from '$lib/server/mcp/registry';
import type { LoadedMcpServer } from '$lib/server/mcp/config';

const SERVER: LoadedMcpServer = {
	id: 'fastmail',
	displayName: 'Fastmail',
	transport: 'http',
	auth: 'per_user',
	url: 'https://example.test/mcp',
	timeoutSeconds: 30,
	idleTimeoutSeconds: 900,
	deferTools: false,
} as LoadedMcpServer;

vi.mock('$lib/server/mcp/registry', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/mcp/registry')>(
		'$lib/server/mcp/registry',
	);
	return { ...actual, getMcpServerCfg: () => SERVER };
});

const TOOLS = [
	{ name: 'search_email', description: 'Search', inputSchema: { type: 'object' as const } },
	{ name: 'send_email', description: 'Send', inputSchema: { type: 'object' as const } },
];

function state(over: Partial<UserServerState> = {}): UserServerState {
	return {
		id: 'fastmail',
		displayName: 'Fastmail',
		transport: 'http',
		auth: 'per_user',
		state: 'connected',
		error: null,
		tools: TOOLS,
		configured: true,
		...over,
	};
}

const names = (defs: { function: { name: string } }[]) => defs.map((d) => d.function.name);

describe('per-user MCP tools survive a transport blip', () => {
	it('advertises tools for a CONNECTED server', async () => {
		const defs = await buildUserMcpToolDefinitions('u1', { states: [state()] });
		expect(names(defs)).toEqual(['mcp__fastmail__search_email', 'mcp__fastmail__send_email']);
	});

	it('keeps advertising while the server is RECONNECTING, using the cached descriptors', async () => {
		// The two routine ways a healthy server lands here:
		//   1. its handshake overran the send path's 2.5s hot-path budget;
		//   2. the idle reaper closed the connection between two turns.
		// In both cases the registry is still holding the tool descriptors it
		// discovered earlier. Gating on `state === 'connected'` threw them away, so
		// a user who stepped away from a conversation for longer than the idle
		// timeout came back to find the server's tools silently gone for exactly one
		// turn — a payload change, and a capability change, that nobody asked for.
		const defs = await buildUserMcpToolDefinitions('u1', {
			states: [state({ state: 'reconnecting' })],
		});
		expect(names(defs)).toEqual(['mcp__fastmail__search_email', 'mcp__fastmail__send_email']);
	});

	it('produces a byte-identical tools[] across a connected -> reconnecting -> connected cycle', async () => {
		// The property the prefix cache actually depends on.
		const turn = async (s: UserServerState['state']) =>
			JSON.stringify(await buildUserMcpToolDefinitions('u1', { states: [state({ state: s })] }));

		expect(await turn('reconnecting')).toBe(await turn('connected'));
		expect(await turn('idle')).toBe(await turn('connected'));
	});

	it('advertises nothing for a FAILED server', async () => {
		// A settled failure is different from a blip: it's surfaced to the user as an
		// "unavailable" notice, so dropping the tools is the honest thing to do.
		const defs = await buildUserMcpToolDefinitions('u1', {
			states: [state({ state: 'failed', error: 'bad token' })],
		});
		expect(defs).toEqual([]);
	});

	it('advertises nothing on a first-ever connect that has not discovered tools yet', async () => {
		// Reconnecting with no cached descriptors — there is genuinely nothing to say.
		const defs = await buildUserMcpToolDefinitions('u1', {
			states: [state({ state: 'reconnecting', tools: [] })],
		});
		expect(defs).toEqual([]);
	});

	it('still honours the per-conversation mcp:<id> opt-out', async () => {
		const defs = await buildUserMcpToolDefinitions('u1', {
			states: [state({ state: 'reconnecting' })],
			excludeCategories: ['mcp:fastmail'],
		});
		expect(defs).toEqual([]);
	});

	it('advertises nothing for a server the user has no credential for', async () => {
		const defs = await buildUserMcpToolDefinitions('u1', {
			states: [state({ configured: false, state: 'needs-credential', tools: [] })],
		});
		expect(defs).toEqual([]);
	});
});

describe('a redundant skill re-activation must not disturb the prefix', () => {
	const skill = (body: string) => `<skill_content name="research">\n${body}\n</skill_content>`;
	const BODY = 'B'.repeat(60_000); // a real skill body runs to 64 KiB

	/** The payload as of the turn where the skill was first activated. */
	const turnN = [
		{ role: 'user' as const, content: 'research this' },
		{
			role: 'assistant' as const,
			content: null,
			tool_calls: [
				{
					id: 'c1',
					type: 'function' as const,
					function: { name: 'activate_skill', arguments: '{}' },
				},
			],
		},
		{ role: 'tool' as const, content: skill(BODY), tool_call_id: 'c1' },
		{ role: 'assistant' as const, content: 'done' },
	];

	/** …and many turns later the model activates it again. */
	const turnLater = [
		...turnN,
		{ role: 'user' as const, content: 'now research that' },
		{
			role: 'assistant' as const,
			content: null,
			tool_calls: [
				{
					id: 'c2',
					type: 'function' as const,
					function: { name: 'activate_skill', arguments: '{}' },
				},
			],
		},
		{ role: 'tool' as const, content: skill(BODY), tool_call_id: 'c2' },
	];

	it('leaves every token of the earlier turns byte-identical', () => {
		// THE property. Keep-last would rewrite the 64 KiB body at index 2 down to a
		// stub — a change in the MIDDLE of the prompt, which diverges the upstream's
		// KV prefix there and re-prefills everything after it. Keep-first touches
		// nothing before the new turn.
		const before = collapseSupersededSkillActivations(turnN);
		const after = collapseSupersededSkillActivations(turnLater);

		expect(after.slice(0, turnN.length)).toEqual(before);
	});

	it('carries the body exactly once, so the reload is not paid for twice', () => {
		const after = collapseSupersededSkillActivations(turnLater);
		const full = after.filter((m) => typeof m.content === 'string' && m.content.includes(BODY));
		expect(full).toHaveLength(1);
	});

	it('points the model back at the copy it already has', () => {
		const after = collapseSupersededSkillActivations(turnLater);
		const stub = after[after.length - 1].content as string;
		expect(stub).toContain('duplicate="true"');
		expect(stub).toMatch(/earlier in this conversation/i);
		expect(stub.length).toBeLessThan(300); // a stub, not a body
	});
});
