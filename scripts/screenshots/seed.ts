/**
 * Seed a sealed demo database + media dir for README screenshot capture.
 *
 * Modeled on tests/e2e/global-setup.ts: migrates a fresh SQLite file at
 * scripts/screenshots/.demo-data/demo.db, inserts a demo user + session,
 * and writes a Playwright storage-state file so capture.ts starts
 * authenticated. Never touches the real ./data directory.
 *
 * Demo content is crafted, not generated: assistant markdown is rendered
 * through the app's own server renderer (markdown-it + shiki) so the
 * screenshots show exactly what real persisted messages look like, and
 * gallery images are procedural gradient art rasterized with sharp.
 *
 * Run with: pnpm exec tsx scripts/screenshots/seed.ts
 */

import { mkdirSync, existsSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import sharp from 'sharp';
import * as schema from '../../src/lib/server/db/schema';
import { renderMarkdown } from '../../src/lib/server/markdown/render';
import type { MessagePart } from '../../src/lib/types/api';

const DATA_DIR = resolve('./scripts/screenshots/.demo-data');
const DB_PATH = resolve(DATA_DIR, 'demo.db');
const MEDIA_DIR = resolve(DATA_DIR, 'media');
const STORAGE_STATE_PATH = resolve(DATA_DIR, 'auth.json');

const USER_ID = '00000000-0000-0000-0000-00000000d001';
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;

const id = () => randomUUID().replaceAll('-', '');

// --- procedural gradient art ----------------------------------------------
// Deterministic abstract compositions: layered radial gradients + a soft
// grain veil. Good enough to read as "generated art" at gallery-thumbnail
// and chat-bubble sizes without shipping real model output.

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PALETTES: string[][] = [
	['#0b1026', '#f59e0b', '#fb7185', '#7c3aed'], // golden-hour
	['#10081f', '#22d3ee', '#a78bfa', '#f472b6'], // synthwave
	['#041b15', '#34d399', '#a3e635', '#0ea5e9'], // aurora
	['#1c0a05', '#f97316', '#facc15', '#ef4444'], // ember
	['#0a1220', '#60a5fa', '#e2e8f0', '#38bdf8'], // glacier
	['#160a1e', '#e879f9', '#f0abfc', '#6366f1'], // orchid
];

/** Mix two #rrggbb colors; t=0 → a, t=1 → b. */
function mix(a: string, b: string, t: number): string {
	const ch = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16);
	const lerp = (x: number, y: number) => Math.round(x + (y - x) * t);
	return (
		'#' +
		[1, 3, 5]
			.map((i) =>
				lerp(ch(a.slice(1), i - 1), ch(b.slice(1), i - 1))
					.toString(16)
					.padStart(2, '0'),
			)
			.join('')
	);
}

function artSvg(seed: number, w: number, h: number): string {
	const rnd = mulberry32(seed * 7349 + 11);
	const palette = PALETTES[seed % PALETTES.length];
	const [bg, glow, warm, cool] = palette;

	// Sky: deep base falling into a glowing horizon band.
	const horizonY = h * (0.55 + rnd() * 0.18);
	const sky = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="${((horizonY / h) * 70).toFixed(0)}%" stop-color="${mix(bg, cool, 0.45)}"/>
      <stop offset="${((horizonY / h) * 100).toFixed(0)}%" stop-color="${mix(glow, warm, 0.5)}"/>
      <stop offset="100%" stop-color="${mix(bg, warm, 0.2)}"/>
    </linearGradient>`;

	// Sun / moon disk with a wide radial glow, sitting near the horizon.
	const sunX = w * (0.25 + rnd() * 0.5);
	const sunY = horizonY - h * (0.02 + rnd() * 0.12);
	const sunR = Math.min(w, h) * (0.07 + rnd() * 0.07);
	const sun = `<radialGradient id="halo"><stop offset="0%" stop-color="${glow}" stop-opacity="0.9"/><stop offset="100%" stop-color="${glow}" stop-opacity="0"/></radialGradient>`;

	// Layered mountain ridges, darkening toward the foreground.
	let ridges = '';
	const layers = 3 + Math.floor(rnd() * 2);
	for (let l = 0; l < layers; l++) {
		const base = horizonY + ((h - horizonY) * (l + 0.4)) / (layers + 0.4);
		const amp = (h - horizonY) * (0.1 + rnd() * 0.22);
		const segs = 6 + Math.floor(rnd() * 5);
		let d = `M0 ${h} L0 ${(base - rnd() * amp).toFixed(0)}`;
		for (let s = 1; s <= segs; s++) {
			const x = (w / segs) * s;
			const y = base - rnd() * amp;
			d += ` L${x.toFixed(0)} ${y.toFixed(0)}`;
		}
		d += ` L${w} ${h} Z`;
		const shade = mix(mix(bg, '#000000', 0.25 + (l / layers) * 0.55), cool, 0.12);
		ridges += `<path d="${d}" fill="${shade}"/>`;
	}

	// A few faint stars in the upper sky.
	let stars = '';
	const n = 18 + Math.floor(rnd() * 22);
	for (let i = 0; i < n; i++) {
		const x = rnd() * w;
		const y = rnd() * horizonY * 0.7;
		stars += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(0.6 + rnd() * 1.4).toFixed(1)}" fill="#ffffff" opacity="${(0.15 + rnd() * 0.5).toFixed(2)}"/>`;
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>${sky}${sun}</defs>
  <rect width="${w}" height="${h}" fill="url(#sky)"/>
  ${stars}
  <circle cx="${sunX.toFixed(0)}" cy="${sunY.toFixed(0)}" r="${(sunR * 3.2).toFixed(0)}" fill="url(#halo)"/>
  <circle cx="${sunX.toFixed(0)}" cy="${sunY.toFixed(0)}" r="${sunR.toFixed(0)}" fill="${glow}"/>
  ${ridges}
</svg>`;
}

// --- DB helpers ------------------------------------------------------------

const sqliteExists = existsSync(DB_PATH);
if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(MEDIA_DIR, { recursive: true });

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');
const db = drizzle({ client: sqlite, schema });
migrate(db, { migrationsFolder: resolve('./drizzle') });

type MsgInput = {
	conversationId: string;
	parentMessageId: string | null;
	role: 'user' | 'assistant';
	parts: MessagePart[];
	markdown?: string; // assistant text to render into content_html
	reasoning?: string;
	modelUsed?: string;
	tokensIn?: number;
	tokensOut?: number;
	genMs?: number;
	createdAt: number;
};

async function insertMessage(input: MsgInput): Promise<string> {
	const messageId = id();
	const contentHtml = input.markdown ? await renderMarkdown(input.markdown) : null;
	db.insert(schema.messages)
		.values({
			id: messageId,
			conversationId: input.conversationId,
			parentMessageId: input.parentMessageId,
			role: input.role,
			contentJson: JSON.stringify(input.parts),
			contentHtml,
			reasoningText: input.reasoning ?? null,
			finishReason: input.role === 'assistant' ? 'stop' : null,
			modelUsed: input.modelUsed ?? null,
			tokensIn: input.tokensIn ?? null,
			tokensOut: input.tokensOut ?? null,
			genMs: input.genMs ?? null,
			createdAt: input.createdAt,
		})
		.run();
	return messageId;
}

type ConvInput = {
	title: string;
	endpointId: string;
	modelId: string; // namespaced endpoint::upstream
	modelKind: 'chat' | 'image' | 'video';
	createdAt: number;
};

function insertConversation(input: ConvInput): string {
	const conversationId = id();
	db.insert(schema.conversations)
		.values({
			id: conversationId,
			userId: USER_ID,
			title: input.title,
			titleSource: 'ai',
			endpointId: input.endpointId,
			modelId: input.modelId,
			modelKind: input.modelKind,
			createdAt: input.createdAt,
			updatedAt: input.createdAt,
		})
		.run();
	return conversationId;
}

function touchConversation(conversationId: string, updatedAt: number, activeLeaf: string | null) {
	db.update(schema.conversations)
		.set({ updatedAt, activeLeafMessageId: activeLeaf })
		.where(eq(schema.conversations.id, conversationId))
		.run();
}

async function insertArtMedia(opts: {
	seed: number;
	w: number;
	h: number;
	sourceModel: string;
	prompt: string;
	createdAt: number;
}): Promise<string> {
	const mediaId = id();
	const rel = `${mediaId.slice(0, 2)}/${mediaId.slice(2, 4)}/${mediaId}.png`;
	const abs = resolve(MEDIA_DIR, rel);
	mkdirSync(dirname(abs), { recursive: true });
	await sharp(Buffer.from(artSvg(opts.seed, opts.w, opts.h)))
		.png()
		.toFile(abs);
	db.insert(schema.media)
		.values({
			id: mediaId,
			userId: USER_ID,
			storagePath: rel,
			contentType: 'image/png',
			byteSize: statSync(abs).size,
			kind: 'image',
			origin: 'generated',
			sourceEndpointId: opts.sourceModel.split('::')[0],
			sourceModel: opts.sourceModel,
			promptExcerpt: opts.prompt.slice(0, 500),
			promptFull: opts.prompt,
			createdAt: opts.createdAt,
			refCount: 1,
		})
		.run();
	return mediaId;
}

function linkMedia(messageId: string, mediaId: string) {
	db.insert(schema.messageMedia).values({ messageId, mediaId }).run();
}

// --- user + session ---------------------------------------------------------

db.insert(schema.users)
	.values({
		id: USER_ID,
		email: 'demo@example.test',
		displayName: 'Sam',
		createdAt: NOW - 90 * 24 * HOUR,
		lastLoginAt: NOW,
		preferencesJson: JSON.stringify({
			name: 'Sam',
			showGreeting: true,
			theme: 'glyphstream',
			colorScheme: 'system',
			favoriteModels: [
				'workstation::llama-3.3-70b-instruct',
				'bridge::flux-dev',
				'groq::llama-3.1-8b-instant',
			],
		}),
	})
	.run();

const token = randomBytes(20).toString('base64url');
db.insert(schema.sessions)
	.values({
		id: createHash('sha256').update(token).digest('hex'),
		userId: USER_ID,
		expiresAt: NOW + 30 * 24 * HOUR,
	})
	.run();

// --- conversations -----------------------------------------------------------

const LLAMA = 'workstation::llama-3.3-70b-instruct';
const DEEPSEEK = 'workstation::deepseek-r1-distill-qwen-32b';
const GROQ_FAST = 'groq::llama-3.1-8b-instant';
const FLUX_DEV = 'bridge::flux-dev';
const FLUX_SCHNELL = 'bridge::flux-schnell';
const VENICE = 'bridge::venice-sd35';

async function textConversation(opts: {
	title: string;
	modelId: string;
	at: number;
	turns: Array<{
		user: string;
		reasoning?: string;
		assistant: string;
		tokens: [number, number];
		genMs: number;
	}>;
}): Promise<string> {
	const endpointId = opts.modelId.split('::')[0];
	const conv = insertConversation({
		title: opts.title,
		endpointId,
		modelId: opts.modelId,
		modelKind: 'chat',
		createdAt: opts.at,
	});
	let parent: string | null = null;
	let t = opts.at;
	for (const turn of opts.turns) {
		parent = await insertMessage({
			conversationId: conv,
			parentMessageId: parent,
			role: 'user',
			parts: [{ type: 'text', text: turn.user }],
			createdAt: t,
		});
		t += 20_000;
		parent = await insertMessage({
			conversationId: conv,
			parentMessageId: parent,
			role: 'assistant',
			parts: [
				...(turn.reasoning ? [{ type: 'reasoning', text: turn.reasoning } as MessagePart] : []),
				{ type: 'text', text: turn.assistant },
			],
			markdown: turn.assistant,
			reasoning: turn.reasoning,
			modelUsed: opts.modelId,
			tokensIn: turn.tokens[0],
			tokensOut: turn.tokens[1],
			genMs: turn.genMs,
			createdAt: t,
		});
		t += 3 * MIN;
	}
	touchConversation(conv, t, parent);
	return conv;
}

// Conversation ids capture.ts needs to navigate to, written to
// .demo-data/manifest.json at the end.
const manifest: Record<string, string> = {};

// 1) Hero conversation — the chat view screenshot.
manifest.hero = await textConversation({
	title: 'SQLite tuning for write-heavy ingest',
	modelId: LLAMA,
	at: NOW - 25 * MIN,
	turns: [
		{
			user: 'Our ingest service writes about 2k rows/sec into SQLite and the dashboard reads are starting to crawl. What should I tune first?',
			assistant: `With a write rate like that, the biggest wins come from making sure readers and the writer stop blocking each other, then cutting per-transaction overhead.

**1. Switch to WAL mode** (if you haven't) — readers no longer block the writer, and vice versa:

\`\`\`sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;   -- fsync on checkpoint, not every commit
\`\`\`

**2. Batch your inserts.** At 2k rows/sec, one transaction per row spends almost all its time in commit overhead. Batching into ~500-row transactions typically gives a 10–50× throughput win:

\`\`\`python
with db:  # one transaction
    db.executemany(
        "INSERT INTO events (ts, source, payload) VALUES (?, ?, ?)",
        batch,
    )
\`\`\`

**3. Give the page cache room** — the default is tiny:

\`\`\`sql
PRAGMA cache_size = -64000;    -- 64 MB
PRAGMA mmap_size = 268435456;  -- 256 MB, reads bypass the page cache
\`\`\`

**4. Check the dashboard queries with \`EXPLAIN QUERY PLAN\`.** A missing index on your time column is the usual culprit — a covering index over \`(source, ts)\` often turns a full scan into a range read.

If you do all four and reads still lag during bursts, the next lever is moving the dashboard to a read replica of the WAL file — but measure first; the four above usually get you there.`,
			tokens: [184, 412],
			genMs: 9_800,
		},
		{
			user: 'WAL checkpointing stalls us during bursts — anything we can do about that?',
			assistant: `Yes — take checkpointing off the write path entirely.

By default SQLite checkpoints *passively* from whichever connection happens to push the WAL past 1000 pages, which means your ingest thread occasionally pays for the whole flush. Instead:

\`\`\`sql
PRAGMA wal_autocheckpoint = 0;  -- never checkpoint from the hot path
\`\`\`

…and run the checkpoint from a dedicated maintenance thread on a timer:

\`\`\`python
def checkpoint_loop(db, every=5.0):
    while True:
        time.sleep(every)
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
\`\`\`

\`TRUNCATE\` resets the WAL file size, so a burst can't grow it unboundedly. The trade-off is the WAL grows between sweeps — size the interval so the WAL stays comfortably inside your page cache (a few seconds is typical).

One caveat: \`wal_checkpoint(TRUNCATE)\` needs a moment with no active readers to fully truncate. If the dashboard holds long-running read transactions, prefer \`RESTART\` and let file size float.`,
			tokens: [630, 287],
			genMs: 6_400,
		},
	],
});

// 2) Image fan-out — parked compare grid for the fanout screenshot.
{
	const at = NOW - 8 * MIN;
	const conv = (manifest.fanout = insertConversation({
		title: 'Lighthouse at golden hour',
		endpointId: 'bridge',
		modelId: FLUX_DEV,
		modelKind: 'image',
		createdAt: at,
	}));
	const prompt =
		'A lighthouse on a basalt cliff at golden hour, crashing waves, volumetric light, cinematic wide shot';
	const userMsg = await insertMessage({
		conversationId: conv,
		parentMessageId: null,
		role: 'user',
		parts: [{ type: 'text', text: prompt }],
		createdAt: at,
	});
	// Two branches: the compare grid wraps at two columns, so two is the
	// largest count that screenshots as a complete, uncropped grid.
	const branches: Array<[string, number, number]> = [
		[FLUX_DEV, 0, 21_400],
		[VENICE, 3, 14_900],
	];
	for (const [model, seed, genMs] of branches) {
		// Landscape ("cinematic wide shot") keeps the tiles short enough that
		// the whole grid + its Regenerate row clears the composer in the shot.
		const mediaId = await insertArtMedia({
			seed,
			w: 1216,
			h: 832,
			sourceModel: model,
			prompt,
			createdAt: at + genMs,
		});
		const msg = await insertMessage({
			conversationId: conv,
			parentMessageId: userMsg,
			role: 'assistant',
			parts: [{ type: 'image', mediaId }],
			modelUsed: model,
			genMs,
			createdAt: at + genMs,
		});
		linkMedia(msg, mediaId);
	}
	// Park the fan-out: leaf pinned at the user message, marker set, so the
	// page rehydrates the compare grid exactly like a real unresolved fan-out.
	db.update(schema.conversations)
		.set({
			updatedAt: at + 22 * 1000,
			activeLeafMessageId: userMsg,
			fanoutParentMessageId: userMsg,
		})
		.where(eq(schema.conversations.id, conv))
		.run();
}

// 3) Image chain — fills the gallery alongside the fan-out images.
{
	const at = NOW - 26 * HOUR;
	const conv = insertConversation({
		title: 'Synthwave skyline posters',
		endpointId: 'bridge',
		modelId: FLUX_DEV,
		modelKind: 'image',
		createdAt: at,
	});
	const prompts = [
		'Synthwave city skyline at dusk, neon grid horizon, retro poster composition',
		'Same skyline, but raining — wet asphalt reflections, moodier palette',
		'Aurora over a glacier field, long exposure, ultra wide',
		'Ember storm over volcanic dunes, abstract, high contrast',
		'Orchid nebula, deep field, soft bloom',
		'Glacier melt pools from above, abstract topography, muted blues',
	];
	const modelFor = (i: number) => (i === 2 ? VENICE : i === 4 ? FLUX_SCHNELL : FLUX_DEV);
	let parent: string | null = null;
	let t = at;
	for (let i = 0; i < prompts.length; i++) {
		parent = await insertMessage({
			conversationId: conv,
			parentMessageId: parent,
			role: 'user',
			parts: [{ type: 'text', text: prompts[i] }],
			createdAt: t,
		});
		const genMs = 12_000 + i * 1_700;
		const mediaId = await insertArtMedia({
			seed: i + 1,
			w: i % 2 === 0 ? 1216 : 1024,
			h: i % 2 === 0 ? 832 : 1024,
			sourceModel: modelFor(i),
			prompt: prompts[i],
			createdAt: t + genMs,
		});
		parent = await insertMessage({
			conversationId: conv,
			parentMessageId: parent,
			role: 'assistant',
			parts: [{ type: 'image', mediaId }],
			modelUsed: modelFor(i),
			genMs,
			createdAt: t + genMs,
		});
		linkMedia(parent, mediaId);
		t += 40 * MIN;
	}
	touchConversation(conv, t, parent);
}

// 4) Sidebar filler — recents list with believable titles + searchable text.
await textConversation({
	title: 'Explain Reciprocal Rank Fusion',
	modelId: DEEPSEEK,
	at: NOW - 3 * HOUR,
	turns: [
		{
			user: 'Explain Reciprocal Rank Fusion like I know BM25 but not much else.',
			reasoning:
				'The user knows BM25, so anchor on "you already have one ranked list" and motivate combining a second ranking without score normalization. The 1/(k + rank) formula is the whole trick — emphasize why rank, not score.',
			assistant: `You already have BM25 giving you a ranked list. Now suppose you also have a second ranker — say, embedding cosine similarity — and the two disagree. RRF is the simplest defensible way to merge them.

The trick: **ignore the scores, keep only the ranks.** Each document's fused score is

\`\`\`
RRF(d) = Σ over rankers of  1 / (k + rank(d))
\`\`\`

with \`k ≈ 60\` in practice. A document ranked #1 by BM25 and #3 by embeddings gets \`1/61 + 1/63\`.

Why ranks instead of scores? BM25 scores and cosine similarities live on completely different scales — normalizing them is fragile and query-dependent. Ranks are already comparable. The \`k\` constant keeps a single #1 from dominating: the gap between rank 1 and rank 2 is tiny relative to \`k\`, so a document needs *agreement* across rankers to float to the top.`,
			tokens: [96, 231],
			genMs: 5_100,
		},
	],
});

await textConversation({
	title: 'Flaky Playwright test triage',
	modelId: LLAMA,
	at: NOW - 7 * HOUR,
	turns: [
		{
			user: "A Playwright spec passes alone but fails in the suite with 'element is not attached to the DOM'. Where do I start?",
			assistant: `That error is almost always a stale locator handle surviving a re-render — and it showing up only in the suite points at shared state from an earlier test changing what triggers the re-render.

Start with these, in order:

1. **Re-query, don't cache.** If the spec stores \`const row = page.locator(...)\` and the list re-renders between actions, act through a fresh locator chain instead: \`page.getByRole('row', { name: ... })\` at each step. Locators are lazy, but a \`.first()\` materialized into an element handle is not.
2. **Find the cross-test state.** Run the failing spec preceded by each earlier spec via \`--repeat-each=1 --grep\` bisection until you find the pair that reproduces. Common culprits: storage state, a seeded DB row with a same-name fixture, a service worker from the previous test.
3. **Watch for animation-driven re-mounts.** If the component animates in via a \`{#key}\` block or portal, assert on a post-animation signal (\`data-state="open"\`) before interacting.

If you paste the spec I can point at the specific handle that's going stale.`,
			tokens: [88, 254],
			genMs: 5_900,
		},
	],
});

await textConversation({
	title: 'Kyoto in 36 hours',
	modelId: GROQ_FAST,
	at: NOW - 2 * 24 * HOUR,
	turns: [
		{
			user: "Landing in Kyoto Friday 6pm, leaving Sunday morning. One temple, one market, one good coffee — what's the move?",
			assistant: `Tight but doable. The trick is doing the temple at opening, before the crowds.

**Friday evening** — drop bags, head to **Nishiki Market**'s east end around 7pm as the dinner counters take over from the day stalls. Walk it west to east, eat as you go (tamagoyaki, yuba, the standing sake bar near Teramachi).

**Saturday, early** — **Fushimi Inari at 7am**. You'll have the lower gates nearly alone; climb to the Yotsutsuji overlook (~40 min) and turn around there — the summit loop adds an hour for a worse view. Coffee after at **Vermillion Espresso** near the shrine exit, then spend the afternoon in Higashiyama's lanes while your legs forgive you.

**Sunday** — if your train's after 9, the Kamo river path at dawn is five quiet minutes you'll remember longer than any itinerary stop.`,
			tokens: [74, 209],
			genMs: 1_900,
		},
	],
});

await textConversation({
	title: 'Extract a reusable SSE parser',
	modelId: LLAMA,
	at: NOW - 3 * 24 * HOUR,
	turns: [
		{
			user: 'I keep hand-rolling SSE parsing in fetch streams. Sketch a minimal reusable parser?',
			assistant: `The shape that holds up: a tiny push-parser you feed decoded chunks, emitting events on blank-line boundaries — no async iterators in the core, so it works in any stream context.

\`\`\`typescript
export function createSseParser(onEvent: (data: string) => void) {
	let buffer = '';
	return (chunk: string) => {
		buffer += chunk;
		let idx: number;
		while ((idx = buffer.indexOf('\\n\\n')) !== -1) {
			const frame = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const data = frame
				.split('\\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trimStart())
				.join('\\n');
			if (data) onEvent(data);
		}
	};
}
\`\`\`

Two real-world hardenings before you trust it: cap \`buffer\` so a server that never sends a blank line can't grow it unboundedly, and handle \`\\r\\n\` if you don't control the upstream. (Honestly — at that point, consider the \`eventsource-parser\` package; it's 1 KB and has already met every weird server you haven't.)`,
			tokens: [52, 268],
			genMs: 6_200,
		},
	],
});

sqlite.close();

// --- Playwright storage state ------------------------------------------------

writeFileSync(
	STORAGE_STATE_PATH,
	JSON.stringify(
		{
			cookies: [
				{
					name: 'glyphstream_session',
					value: token,
					domain: 'localhost',
					path: '/',
					expires: (NOW + 30 * 24 * HOUR) / 1000,
					httpOnly: true,
					secure: false,
					sameSite: 'Lax' as const,
				},
			],
			origins: [],
		},
		null,
		2,
	),
);

writeFileSync(resolve(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`[seed] demo data ready at ${DATA_DIR}${sqliteExists ? ' (recreated)' : ''}`);
console.log(`[seed] conversations: ${JSON.stringify(manifest)}`);
