/**
 * Route test for PATCH /api/custom-models/:id: an emptied optional field
 * clears the stored value, and an absent one leaves it alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { createCustomModel, getCustomModelForUser } from '#lib/server/db/queries/custom-models.js';
import { PATCH } from '../../src/routes/api/custom-models/[id]/+server';

let userId: string;
let presetId: string;

beforeEach(() => {
	createTestDb();
	userId = seedUser().id;
	presetId = createCustomModel({
		userId,
		name: 'Terse',
		description: 'Short answers',
		baseEndpointId: 'bridge',
		baseModelId: 'gpt-4o',
		systemPrompt: 'You are terse.',
		parameters: { temperature: 0.4 },
	}).id;
});
afterEach(() => closeTestDb());

function patch(body: unknown) {
	return PATCH({
		locals: { user: { id: userId, role: 'user' } },
		params: { id: presetId },
		request: new Request(`http://x/api/custom-models/${presetId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	} as never);
}

describe('PATCH /api/custom-models/:id', () => {
	it("clears the system prompt, description and parameters sent as '' / null", async () => {
		const res = await patch({ systemPrompt: '', description: '', parameters: null });
		expect(res.status).toBe(200);
		expect(getCustomModelForUser(presetId, userId)).toMatchObject({
			systemPrompt: null,
			description: null,
			parameters: null,
		});
	});

	it('leaves fields the body does not name untouched', async () => {
		await patch({ name: 'Terser' });
		expect(getCustomModelForUser(presetId, userId)).toMatchObject({
			name: 'Terser',
			systemPrompt: 'You are terse.',
			description: 'Short answers',
			parameters: { temperature: 0.4 },
		});
	});
});
