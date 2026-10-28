/**
 * The migration that gives photos their own setting (`*_photos_per_preset`):
 * every texting preset and texting chat is switched on, since their system
 * prompt already carried the photo instruction, and nothing else is. Its
 * backfill is re-run by hand against seeded rows (createTestDb already ran it,
 * against nothing).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, closeTestDb, type TestDB } from './_helpers/test-db';
import { seedUser } from './_helpers/seed';
import { createConversation, getConversationMeta } from '#lib/server/db/queries/conversations.js';
import { createCustomModel, getCustomModelForUser } from '#lib/server/db/queries/custom-models.js';

const dir = readdirSync(resolve('./drizzle')).find((d) => d.endsWith('_photos_per_preset'));
if (!dir) throw new Error('photos_per_preset migration directory not found');
const BACKFILL = readFileSync(resolve(`./drizzle/${dir}/migration.sql`), 'utf-8')
	.split('--> statement-breakpoint')
	.map((s) => s.trim())
	.filter((s) => /^(?:--[^\n]*\n)*UPDATE/.test(s));

let db: TestDB;
beforeEach(() => {
	db = createTestDb();
});
afterEach(() => closeTestDb());

it('switches photos on for texting presets and chats, and only those', () => {
	const userId = seedUser().id;
	const preset = (replyStyle: 'texting' | 'standard') =>
		createCustomModel({
			userId,
			name: replyStyle,
			description: null,
			baseEndpointId: 'e',
			baseModelId: 'm',
			systemPrompt: null,
			parameters: null,
			replyStyle,
		}).id;
	const chat = (replyStyle: 'texting' | 'standard') =>
		createConversation({ userId, endpointId: 'e', modelId: 'e::m', modelKind: 'chat', replyStyle })
			.id;
	const presets = { texting: preset('texting'), standard: preset('standard') };
	const chats = { texting: chat('texting'), standard: chat('standard') };

	expect(BACKFILL).toHaveLength(2);
	for (const statement of BACKFILL) db.run(sql.raw(statement));

	expect(getCustomModelForUser(presets.texting, userId)?.photos).toBe(true);
	expect(getCustomModelForUser(presets.standard, userId)?.photos).toBe(false);
	expect(getConversationMeta(chats.texting, userId)?.photos).toBe(true);
	expect(getConversationMeta(chats.standard, userId)?.photos).toBe(false);
});
