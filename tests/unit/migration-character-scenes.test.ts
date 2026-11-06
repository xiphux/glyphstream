/**
 * The migration that turns the texting reply style into 'character'
 * (`*_character_scenes`): every texting preset and chat becomes a character
 * that starts out texting, and nothing else changes. Its backfill is re-run by
 * hand against seeded rows (createTestDb already ran it, against nothing).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { createConversation, getConversationMeta } from '#lib/server/db/queries/conversations.js';
import { createCustomModel, getCustomModelForUser } from '#lib/server/db/queries/custom-models.js';

const dir = readdirSync(resolve('./drizzle')).find((d) => d.endsWith('_character_scenes'));
if (!dir) throw new Error('character_scenes migration directory not found');
const BACKFILL = readFileSync(resolve(`./drizzle/${dir}/migration.sql`), 'utf-8')
	.split('--> statement-breakpoint')
	.map((s) => s.trim())
	.filter((s) => /^(?:--[^\n]*\n)*UPDATE/.test(s));

let db: TestDB;
beforeEach(() => {
	db = createTestDb();
});
afterEach(() => closeTestDb());

it('makes texting presets and chats characters that start texting, and only those', () => {
	const userId = seedUser().id;
	const preset = (name: string) =>
		createCustomModel({
			userId,
			name,
			description: null,
			baseEndpointId: 'e',
			baseModelId: 'm',
			systemPrompt: null,
			parameters: null,
		}).id;
	const chat = () =>
		createConversation({ userId, endpointId: 'e', modelId: 'e::m', modelKind: 'chat' }).id;
	const presets = { texting: preset('texting'), standard: preset('standard') };
	const chats = { texting: chat(), standard: chat() };
	// The old style, which nothing can write any more.
	db.run(sql`UPDATE custom_models SET reply_style = 'texting' WHERE id = ${presets.texting}`);
	db.run(sql`UPDATE conversations SET reply_style = 'texting' WHERE id = ${chats.texting}`);

	expect(BACKFILL).toHaveLength(2);
	for (const statement of BACKFILL) db.run(sql.raw(statement));

	expect(getCustomModelForUser(presets.texting, userId)).toMatchObject({
		replyStyle: 'character',
		startingScene: 'texting',
	});
	expect(getCustomModelForUser(presets.standard, userId)?.replyStyle).toBe('standard');
	expect(getConversationMeta(chats.texting, userId)).toMatchObject({
		replyStyle: 'character',
		startingScene: 'texting',
	});
	expect(getConversationMeta(chats.standard, userId)?.replyStyle).toBe('standard');
});
