/**
 * Reranker answer-presence eval.
 *
 * Measures whether the retrieval pipeline actually puts the *relevant* content
 * into the packed budget — the thing reranking is supposed to improve — across
 * three configs run on identical inputs:
 *
 *   - bm25    : lexical only (embedding = undefined, rerank = undefined)
 *   - embed   : BM25 ⊕ embedding cosine, fused via RRF
 *   - rerank  : the above, then cross-encoder rerank of the top candidates
 *
 * Metric: **answer-presence** — does the known answer span survive into the
 * selected `content`? It's the cheap, honest metric (label one string per case,
 * not every chunk) and it directly measures "did the right section make the
 * cut". With a tight budget only the top ~1 chunk survives, so answer-presence
 * is effectively "did the answer chunk rank first" — a sharp test of ranking
 * quality.
 *
 * This hits the LIVE [embeddings] / [rerank] endpoints from config.toml, so it
 * measures *your* setup. It is NOT part of `pnpm test` (non-deterministic, live
 * I/O). Run with `pnpm eval`.
 *
 * Caveats, stated plainly:
 *   - These are hand-authored fixtures: a small set gives DIRECTION, not
 *     statistical significance. Real proof needs a broader, real-world set.
 *   - Cases are written to span difficulty (easy-lexical, paraphrase,
 *     keyword-trap), NOT rigged so rerank wins — the numbers below are whatever
 *     the live models actually produce.
 *   - Tuned for needle-finding, which is what the feature is for; it says
 *     nothing about whole-doc synthesis.
 */

import { describe, it, expect } from 'vitest';
import { selectRelevant } from '$lib/server/retrieval/select';
import { chunkArticleHtml } from '$lib/server/retrieval/chunker';
import { resolveRelevanceConfig } from '$lib/server/retrieval/embeddings-config';
import { resolveRerankConfig } from '$lib/server/retrieval/rerank-config';

// Tight enough that ~1 section survives, so selection pressure is real.
const BUDGET = 700;
const signal = new AbortController().signal;

interface Section {
	h: string;
	body: string;
}
interface EvalCase {
	name: string;
	note: string;
	query: string;
	/** Substring that must appear in the selected content for a "hit". */
	answer: string;
	/** Page sections in document order; the answer lives in exactly one. */
	sections: Section[];
}

// Reusable distractor sections (a fictional "Aether X200" drone manual). Plausible
// and on-domain so they aren't trivially separable by length, only by topic.
const D: Record<string, Section> = {
	box: {
		h: 'In the box',
		body: 'Each Aether X200 package contains the aircraft, the remote controller, a USB-C charging cable, two spare propellers, a propeller-removal tool, and a printed quick-start leaflet. Register the serial number within thirty days to activate coverage.',
	},
	pairing: {
		h: 'App pairing',
		body: 'Install the Aether Fly app, power on the controller, and hold the pairing button for three seconds until the status light pulses blue. The app walks you through binding the aircraft, calibrating the compass, and accepting the local airspace rules before the first takeoff.',
	},
	props: {
		h: 'Propeller maintenance',
		body: 'Inspect the propellers before every flight for chips or stress cracks. Replace a damaged propeller immediately using the bundled tool; never fly with a blade that is bent. Spare propellers are keyed so they only seat in the correct rotation direction.',
	},
	firmware: {
		h: 'Firmware updates',
		body: 'New firmware ships through the Aether Fly app every few weeks. Keep the battery above fifty percent during an update and do not power off the aircraft mid-flash. A failed update usually recovers on the next attempt; a bricked controller can be restored over USB-C.',
	},
	warranty: {
		h: 'Warranty',
		body: 'The Aether X200 carries a twelve-month limited warranty covering manufacturing defects. Crash damage, water ingress, and unauthorized modifications are excluded. Keep your proof of purchase; warranty claims require the original order number and the device serial.',
	},
	gimbal: {
		h: 'Gimbal stabilization',
		body: 'A three-axis mechanical gimbal isolates the camera from airframe vibration and sudden attitude changes. Tune the gimbal smoothing in the app for cinematic pans, or stiffen it for fast tracking shots. Lock the gimbal with the transport clip before storing the aircraft.',
	},
	gps: {
		h: 'GPS flight modes',
		body: 'With a strong satellite lock the X200 holds position to within a meter and supports waypoint missions, orbit, and return-to-home. In areas with poor reception it falls back to attitude mode, where the pilot must manage drift manually. Always confirm a home point before launch.',
	},
	storage: {
		h: 'Storage and transport',
		body: 'Store the aircraft in a cool, dry case away from direct sun. For long storage, discharge the battery to around sixty percent. The X200 is not waterproof; avoid flying in rain or fog, and let the airframe dry fully before packing it if it gets damp.',
	},
};

function distractors(...keys: (keyof typeof D)[]): Section[] {
	return keys.map((k) => D[k]);
}

const CASES: EvalCase[] = [
	{
		name: 'lexical-direct',
		note: 'answer uses the query terms verbatim — BM25 should already win',
		query: 'what is the maximum payload of the Aether X200',
		answer: '4.5 kilograms',
		sections: [
			...distractors('box', 'pairing'),
			{
				h: 'Payload',
				body: 'The Aether X200 supports a maximum payload of 4.5 kilograms in standard flight mode, dropping to about 3.2 kilograms in high-wind conditions where the motors need extra headroom for stability.',
			},
			...distractors('warranty', 'storage'),
		],
	},
	{
		name: 'paraphrase-weight',
		note: 'query paraphrases the answer; a lexical "weight" distractor competes',
		query: 'how much can the drone lift before it struggles',
		answer: '4.5 kilograms',
		sections: [
			...distractors('box'),
			{
				h: 'Weight and dimensions',
				body: 'The X200 airframe itself weighs just 1.2 kilograms and folds to 18 centimeters for transport. Its light weight keeps it within the registration-exempt category in many regions, though local rules vary by takeoff weight.',
			},
			...distractors('gps'),
			{
				h: 'Lifting capacity',
				body: 'Under calm conditions the aircraft can carry up to 4.5 kilograms of attached gear before motor performance degrades and altitude hold becomes unreliable. Heavier loads are possible briefly but shorten flight time sharply.',
			},
			...distractors('warranty', 'firmware'),
		],
	},
	{
		name: 'keyword-trap-endurance',
		note: 'a battery/charge section stuffs the query keywords but lacks the answer',
		query: 'how long can the X200 fly on a single charge',
		answer: '38 minutes',
		sections: [
			...distractors('box', 'pairing'),
			{
				h: 'Battery care',
				body: 'Charge the X200 battery fully before first use. The charge indicator blinks while the battery is charging and turns solid when the charge completes. Never leave a battery on charge unattended, and stop charging a battery that feels hot to the touch.',
			},
			...distractors('props'),
			{
				h: 'Endurance',
				body: 'A fully charged pack delivers roughly 38 minutes of continuous flight under calm conditions with no payload. Wind, aggressive maneuvers, and attached gear all reduce that figure, so plan to land with a comfortable reserve.',
			},
			...distractors('storage', 'warranty'),
		],
	},
	{
		name: 'paraphrase-camera',
		note: 'query asks "resolution"; answer phrases it as 4K with pixel dims',
		query: 'what video resolution does the onboard camera record',
		answer: '3840 by 2160',
		sections: [
			...distractors('gimbal'),
			{
				h: 'Camera capture',
				body: 'The integrated camera captures footage at up to 4K (3840 by 2160) at 60 frames per second, with a 10-bit color profile for grading. Lower resolutions unlock higher frame rates for slow-motion work.',
			},
			...distractors('storage', 'pairing', 'gps'),
		],
	},
	{
		name: 'rank-pressure-temp',
		note: 'answer sits late among many distractors',
		query: 'what is the safe operating temperature range',
		answer: 'between -10 and 40 degrees',
		sections: [
			...distractors('box', 'pairing', 'props', 'gimbal', 'gps'),
			{
				h: 'Environmental limits',
				body: 'The X200 is rated for operation between -10 and 40 degrees Celsius. Outside that window the battery loses capacity quickly and flight stability is not guaranteed, so warm the pack indoors before cold-weather flights.',
			},
			...distractors('firmware', 'warranty'),
		],
	},
	{
		name: 'control-first-section',
		note: 'answer is in the first section — every config should pass (sanity)',
		query: 'what accessories are included in the box',
		answer: 'two spare propellers',
		sections: [...distractors('box', 'pairing', 'warranty', 'storage')],
	},
];

type ConfigKey = 'bm25' | 'embed' | 'rerank';

async function answerPresent(
	c: EvalCase,
	emb: ReturnType<typeof resolveRelevanceConfig>,
	rr: ReturnType<typeof resolveRerankConfig>,
): Promise<boolean> {
	const chunks = chunkArticleHtml(
		c.sections.map((s) => `<h2>${s.h}</h2><p>${s.body}</p>`).join('\n'),
		'Aether X200 Manual',
	);
	const res = await selectRelevant(chunks, c.query, BUDGET, signal, emb, rr);
	return res.content.includes(c.answer);
}

describe('reranker answer-presence eval', () => {
	it('measures answer-presence across bm25 / +embed / +rerank', async () => {
		const emb = resolveRelevanceConfig();
		const rr = resolveRerankConfig();

		const configs: { key: ConfigKey; emb: typeof emb; rr: typeof rr }[] = [
			{ key: 'bm25', emb: undefined, rr: undefined },
			{ key: 'embed', emb, rr: undefined },
			{ key: 'rerank', emb, rr },
		];

		const rows: { name: string; note: string; result: Record<ConfigKey, boolean> }[] = [];
		for (const c of CASES) {
			const result = {} as Record<ConfigKey, boolean>;
			for (const cfg of configs) result[cfg.key] = await answerPresent(c, cfg.emb, cfg.rr);
			rows.push({ name: c.name, note: c.note, result });
		}

		// ---- Report -----------------------------------------------------------
		const lines: string[] = [];
		lines.push('');
		lines.push('Reranker answer-presence eval');
		lines.push('='.repeat(72));
		lines.push(
			`embeddings: ${emb ? `active (${emb.modelId})` : 'NOT configured — embed col == bm25'}`,
		);
		lines.push(
			`rerank:     ${rr ? `active (${rr.modelId})` : 'NOT configured — rerank col == embed'}`,
		);
		lines.push(`budget:     ${BUDGET} chars   cases: ${CASES.length}`);
		lines.push('-'.repeat(72));
		lines.push(
			`${'case'.padEnd(24)} ${'bm25'.padEnd(6)} ${'embed'.padEnd(6)} ${'rerank'.padEnd(6)}`,
		);
		const mark = (b: boolean) => (b ? ' ✓ ' : ' ✗ ').padEnd(6);
		for (const r of rows) {
			lines.push(
				`${r.name.padEnd(24)} ${mark(r.result.bm25)} ${mark(r.result.embed)} ${mark(r.result.rerank)}  ${r.note}`,
			);
		}
		lines.push('-'.repeat(72));
		const total = (k: ConfigKey) => rows.filter((r) => r.result[k]).length;
		lines.push(
			`${'TOTAL'.padEnd(24)} ${`${total('bm25')}/${rows.length}`.padEnd(6)} ${`${total('embed')}/${rows.length}`.padEnd(6)} ${`${total('rerank')}/${rows.length}`.padEnd(6)}`,
		);

		// Marginal effect of each stage, stated as case-level deltas.
		const gained = (from: ConfigKey, to: ConfigKey) =>
			rows.filter((r) => !r.result[from] && r.result[to]).map((r) => r.name);
		const lost = (from: ConfigKey, to: ConfigKey) =>
			rows.filter((r) => r.result[from] && !r.result[to]).map((r) => r.name);
		lines.push('-'.repeat(72));
		lines.push(
			`embed vs bm25   gained: [${gained('bm25', 'embed').join(', ')}]  regressed: [${lost('bm25', 'embed').join(', ')}]`,
		);
		lines.push(
			`rerank vs embed gained: [${gained('embed', 'rerank').join(', ')}]  regressed: [${lost('embed', 'rerank').join(', ')}]`,
		);
		lines.push('='.repeat(72));
		lines.push('');
		console.log(lines.join('\n'));

		// Not part of pnpm test; assert only that the harness ran every case.
		expect(rows).toHaveLength(CASES.length);
		if (!emb)
			console.warn('[eval] no [embeddings] block resolved — embed/rerank columns are degenerate');
		if (!rr) console.warn('[eval] no [rerank] block resolved — rerank column equals embed');
	});
});
