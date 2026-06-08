import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';

const mocks = vi.hoisted(() => ({ testDb: null as unknown as TestDB }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => mocks.testDb,
	closeDb: () => {},
}));
vi.mock('$lib/server/env', async () => {
	const { mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = mkdtempSync(join(tmpdir(), 'gs-synth-test-'));
	return { skillsDir: () => dir };
});

// Register the activate_skill tool so executeToolCalls can resolve it.
import '$lib/server/tools/activate-skill';
import { skillsDir } from '$lib/server/env';
import { createConversation } from '$lib/server/db/queries/conversations';
import { appendMessage, walkActiveBranch } from '$lib/server/db/queries/messages';
import { createSkill, setSkillEnabled, skillStoragePath } from '$lib/server/db/queries/skills';
import { getSkillStore } from '$lib/server/skills/disk-store';
import { synthesizeSkillActivations } from '$lib/server/chat/synthesize-skill-activation';

beforeEach(() => {
	mocks.testDb = createTestDb();
});
afterEach(() => closeTestDb());
afterAll(async () => {
	const { rm } = await import('node:fs/promises');
	await rm(skillsDir(), { recursive: true, force: true }).catch(() => {});
});

const SKILL_MD = `---\nname: review\ndescription: Review code.\n---\n\nReview the code carefully.`;

async function setup() {
	const u = seedUser();
	const conv = createConversation({
		userId: u.id,
		endpointId: 'ep',
		modelId: 'ep::m',
		modelKind: 'chat',
	});
	const userMsg = appendMessage({
		conversationId: conv.id,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: '/review check this' }],
	});
	return { userId: u.id, conversationId: conv.id, userMsgId: userMsg.id };
}

async function makeSkill(userId: string, name: string, body = SKILL_MD) {
	const storagePath = skillStoragePath(userId, name);
	await getSkillStore().putBundle(storagePath, [
		{ relPath: 'SKILL.md', bytes: Buffer.from(body, 'utf8') },
	]);
	return createSkill({ userId, name, description: `desc ${name}`, storagePath });
}

describe('synthesizeSkillActivations', () => {
	it('appends assistant(tool_call) → tool(result) and returns the tool message as the leaf', async () => {
		const { userId, conversationId, userMsgId } = await setup();
		await makeSkill(userId, 'review');

		const result = await synthesizeSkillActivations({
			conversationId,
			userId,
			parentMessageId: userMsgId,
			names: ['review'],
			disabledFeatures: [],
			signal: new AbortController().signal,
		});

		expect(result).not.toBeNull();
		const branch = walkActiveBranch(conversationId);
		expect(branch.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);

		// Assistant carries the activate_skill tool_call.
		const assistant = branch[1];
		const toolCall = assistant.parts.find((p) => p.type === 'tool_call');
		expect(toolCall).toMatchObject({ toolName: 'activate_skill', arguments: '{"name":"review"}' });

		// Tool result carries the wrapped skill body, and is the returned leaf.
		const tool = branch[2];
		expect(result!.leafMessageId).toBe(tool.id);
		const toolResult = tool.parts.find((p) => p.type === 'tool_result');
		expect(toolResult).toBeDefined();
		const resultText = (toolResult as { result: string }).result;
		expect(resultText).toContain('<skill_content name="review">');
		expect(resultText).toContain('Review the code carefully.');

		// The SSE-replay echo mirrors the persisted exchange for live rendering.
		expect(result!.events).toHaveLength(1);
		expect(result!.events[0]).toMatchObject({
			toolName: 'activate_skill',
			arguments: '{"name":"review"}',
			isError: false,
		});
		expect(result!.events[0].result).toContain('<skill_content name="review">');
		expect((toolCall as { toolCallId: string }).toolCallId).toBe(result!.events[0].toolCallId);
	});

	it('returns null and appends nothing when no name resolves to an enabled skill', async () => {
		const { userId, conversationId, userMsgId } = await setup();
		const s = await makeSkill(userId, 'review');
		setSkillEnabled(userId, s.id, false); // disabled → skipped

		const result = await synthesizeSkillActivations({
			conversationId,
			userId,
			parentMessageId: userMsgId,
			names: ['review', 'does-not-exist'],
			disabledFeatures: [],
			signal: new AbortController().signal,
		});

		expect(result).toBeNull();
		expect(walkActiveBranch(conversationId).map((m) => m.role)).toEqual(['user']);
	});

	it('chains multiple skills user → assistant → tool → assistant → tool', async () => {
		const { userId, conversationId, userMsgId } = await setup();
		await makeSkill(userId, 'review');
		await makeSkill(userId, 'pdf');

		const result = await synthesizeSkillActivations({
			conversationId,
			userId,
			parentMessageId: userMsgId,
			names: ['review', 'pdf'],
			disabledFeatures: [],
			signal: new AbortController().signal,
		});

		const branch = walkActiveBranch(conversationId);
		expect(branch.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
		expect(result!.leafMessageId).toBe(branch[4].id);
	});
});
