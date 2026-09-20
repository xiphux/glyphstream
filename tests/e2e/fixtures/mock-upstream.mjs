/**
 * Mock OpenAI-compatible upstream for the e2e suite.
 *
 * GlyphStream's flows talk to an upstream model server over the OpenAI
 * spec (GET /v1/models, POST /v1/chat/completions, POST
 * /v1/images/generations). The real bridge isn't a test dependency, so
 * this dependency-free Node server stands in: deterministic responses,
 * no network, instant. Playwright boots it as a second webServer (see
 * playwright.config.ts) and config.toml points an [[endpoints]] block at
 * it.
 *
 * Deterministic by design — the assistant reply and generated image are
 * fixed so specs can assert on exact rendered text. Two models are
 * advertised so the picker shows both a chat and an image kind:
 *   - mock-chat  (kind: "chat")
 *   - mock-image (kind: "image")
 * `kind` is the openai-api-bridge convention detectKind() reads first.
 *
 * No auth: the fixture endpoint omits api_key_env, so no Authorization
 * header is required.
 */

import process from 'node:process';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 3001);

/** Fixed assistant reply, streamed in word chunks to exercise the
 *  multi-chunk SSE path. Specs assert on this exact string. */
const REPLY_TEXT = 'Hello from the mock upstream.';

/** Fixed summary returned for a compaction request (detected by the
 *  summarizer system prompt). The compaction specs assert on this string. */
const SUMMARY_TEXT = 'MOCK SUMMARY: the earlier turns were condensed.';

/** True when this chat-completion request is GlyphStream asking the model to
 *  compact — its first system message is the summarizer framing (see
 *  SUMMARY_SYSTEM in src/lib/server/chat/compaction.ts). Lets the mock return a
 *  deterministic summary for compaction while normal turns get REPLY_TEXT. */
function isSummarizationRequest(body) {
	const first = Array.isArray(body?.messages) ? body.messages[0] : null;
	return typeof first?.content === 'string' && first.content.includes('compacting a conversation');
}

/** Sentinel a spec can plant in an early (foldable) turn to force a *blank*
 *  summary, so the compaction-failure → confirm-dialog path is deterministic.
 *  When it rides along in a summarization request, the mock streams no text. */
const EMPTY_SUMMARY_MARKER = 'FORCE_EMPTY_SUMMARY';
function wantsEmptySummary(body) {
	return (
		Array.isArray(body?.messages) &&
		body.messages.some(
			(m) => typeof m.content === 'string' && m.content.includes(EMPTY_SUMMARY_MARKER),
		)
	);
}

/** Sentinel a spec can plant in its PROMPT to make `mock-chat-slow` crawl
 *  rather than merely dawdle. `SLOW_CHUNK_DELAY_MS` finishes a reply in about
 *  2s, which is long enough to race a DOM event into but not long enough to
 *  outlast a full page reload or a multi-second client poll interval — both of
 *  which the sidebar generating-dot spec needs. Opt-in per prompt so the shared
 *  slow model's normal timing (and every spec tuned to it) is untouched. */
const GLACIAL_MARKER = 'GLACIAL_STREAM';
function wantsGlacialStream(body) {
	return (
		Array.isArray(body?.messages) &&
		body.messages.some((m) => typeof m.content === 'string' && m.content.includes(GLACIAL_MARKER))
	);
}

/** A real, decodable 1x1 PNG — the media persister hands bytes to sharp
 *  for thumbnailing, so the b64 must be a valid image, not arbitrary
 *  bytes. The previous constant looked like one but had a bad IDAT CRC and a
 *  truncated zlib stream: every thumbnail failed (`vipspng: libpng read
 *  error`), the route fell back to serving the original, and the gallery
 *  still rendered, so nothing noticed. Generated with sharp; flows.spec.ts
 *  now asserts the thumbnail comes back as a real JPEG. */
const PNG_1X1_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQI12OosXr7HwAFfAKjosON1QAAAABJRU5ErkJggg==';

const MODELS = {
	object: 'list',
	data: [
		{
			id: 'mock-chat',
			object: 'model',
			kind: 'chat',
			display_name: 'Mock Chat',
			owned_by: 'mock',
			supports_tools: false,
		},
		{
			// Same as mock-chat but ticks slowly between chunks (see
			// SLOW_CHUNK_DELAY_MS) so e2e specs have a real in-flight
			// window in which to dispatch visibility/connectivity events.
			id: 'mock-chat-slow',
			object: 'model',
			kind: 'chat',
			display_name: 'Mock Chat Slow',
			owned_by: 'mock',
			supports_tools: false,
		},
		{
			// A chat model that advertises a *tiny* context window, so the
			// compaction specs can drive auto-compaction deterministically: any
			// real reply's usage (18 tokens) sits well past a low threshold of
			// this 50-token window. `meta.n_ctx` is the llama.cpp convention
			// GlyphStream's extractContextWindow reads.
			id: 'mock-chat-tiny',
			object: 'model',
			kind: 'chat',
			display_name: 'Mock Chat Tiny',
			owned_by: 'mock',
			supports_tools: false,
			meta: { n_ctx: 50 },
		},
		{
			id: 'mock-image',
			object: 'model',
			kind: 'image',
			display_name: 'Mock Image',
			owned_by: 'mock',
			// openai-api-bridge's aspect-ratio extension, so the composer renders
			// its shape selector. Includes one label-less entry (4:3) because
			// `label` is optional in the contract and the UI must not print a
			// placeholder for it.
			aspect_ratios: [
				{ value: '1:1', label: 'Square' },
				{ value: '3:2', label: 'Photo' },
				{ value: '4:3' },
				{ value: '16:9', label: 'Widescreen' },
			],
			aspect_ratio_default: '1:1',
		},
		{
			// A SECOND image model, so a spec can compare two of them — an avatar
			// draw across several models is the flow that needs it. Deliberately not
			// named "Mock Image Two": several specs address the first one with
			// /Mock Image/i, and a second match would break them on strict mode
			// rather than on anything real.
			id: 'mock-painter',
			object: 'model',
			kind: 'image',
			display_name: 'Mock Painter',
			owned_by: 'mock',
			// A DELIBERATELY different menu from mock-image: the two overlap on 1:1
			// only. That's what makes the union-not-intersection rule observable —
			// comparing them must offer every ratio either one knows, not the one
			// they share.
			aspect_ratios: [
				{ value: '1:1', label: 'Square' },
				{ value: '9:16', label: 'Portrait Widescreen' },
			],
			aspect_ratio_default: '9:16',
		},
		{
			// The only model here that advertises tool support, so it's the only one
			// GlyphStream will send a `tools[]` to. `supports_tools` is resolved
			// per-model with the endpoint as fallback (see models.ts), so this one
			// flag opts in without a second [[endpoints]] block — which would have
			// duplicated every other model in the picker.
			//
			// It reacts (see wantsReaction) rather than calling anything else: a
			// reaction is the one tool call that renders as nothing, which makes it
			// a poor thing to verify anywhere below the browser.
			id: 'mock-chat-tools',
			object: 'model',
			kind: 'chat',
			display_name: 'Mock Chat Tools',
			owned_by: 'mock',
			supports_tools: true,
		},
	],
};

/** The emoji `mock-chat-tools` reacts with. Specs assert on this exact glyph. */
const REACTION_EMOJI = '🎉';

/**
 * Whether this request should come back with a `react_to_message` call
 * alongside the reply.
 *
 * Keyed on the tool actually being ADVERTISED, not on a prompt sentinel. That's
 * the point: it makes "reactions toggled off ⇒ no badge" a real assertion. The
 * mock can't react because GlyphStream didn't offer the tool, which is the
 * behavior under test — a sentinel would only prove the mock does as it's told.
 */
function wantsReaction(body) {
	return (
		body?.model === 'mock-chat-tools' &&
		Array.isArray(body?.tools) &&
		body.tools.some((t) => t?.function?.name === 'react_to_message')
	);
}

/** Sentinel a spec plants in its PROMPT to get the OTHER reaction shape: the
 *  model reacts and writes nothing, so the relay can't short-circuit and loops
 *  for the reply. Worth reproducing because it's what many llama.cpp
 *  function-calling templates do unconditionally — content and tool_calls are
 *  mutually exclusive there — and because the client can't see the extra
 *  iteration from the tool frames, all four of which are suppressed. */
const TEXTLESS_REACTION_MARKER = 'REACT_WITHOUT_TEXT';
function wantsTextlessReaction(body) {
	return (
		Array.isArray(body?.messages) &&
		body.messages.some(
			(m) => typeof m.content === 'string' && m.content.includes(TEXTLESS_REACTION_MARKER),
		)
	);
}

/** True once the reaction's tool result is in the history — i.e. this is the
 *  SECOND iteration of a textless-reaction turn, the one that owes the reply. */
function isPostToolIteration(body) {
	return Array.isArray(body?.messages) && body.messages.some((m) => m?.role === 'tool');
}

function readBody(req) {
	return new Promise((resolve) => {
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => resolve(data));
	});
}

function sendJson(res, status, obj) {
	const payload = JSON.stringify(obj);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

/** Per-chunk delay for `mock-chat-slow`. Picked long enough that a spec
 *  can race events (visibilitychange / offline / online) into the middle
 *  of the relay's stream while `busy=true`, but short enough that the
 *  whole 6-word reply still finishes well inside the default 30s test
 *  timeout. */
const SLOW_CHUNK_DELAY_MS = 250;
const FAST_CHUNK_DELAY_MS = 5;
/** Per-chunk delay when the prompt carries GLACIAL_MARKER — ~8s for the whole
 *  reply, so a generation is still demonstrably running after a page reload
 *  and across the sidebar poll's first tick. */
const GLACIAL_CHUNK_DELAY_MS = 900;

/** Emit the fixed reply as OpenAI chat-completion SSE chunks: a role
 *  chunk, one chunk per word, a finish chunk, a usage chunk, then
 *  [DONE]. Matches what PassthroughNormalizer expects. */
function streamChatCompletion(
	res,
	model,
	text = REPLY_TEXT,
	glacial = false,
	react = false,
	suppressText = false,
) {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-store',
		Connection: 'keep-alive',
	});
	const id = 'chatcmpl-mock';
	const base = { id, object: 'chat.completion.chunk', model: model ?? 'mock-chat' };
	const delay =
		model === 'mock-chat-slow'
			? glacial
				? GLACIAL_CHUNK_DELAY_MS
				: SLOW_CHUNK_DELAY_MS
			: FAST_CHUNK_DELAY_MS;

	const chunks = [];
	chunks.push({
		...base,
		choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
	});
	if (!suppressText) {
		for (const word of text.split(' ')) {
			// Re-attach the space the split removed (except it lands as a
			// leading space on each word after the first, which renders fine).
			const piece = chunks.length === 1 ? word : ` ${word}`;
			chunks.push({
				...base,
				choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
			});
		}
	}
	if (react) {
		// Emitted AFTER the text, which is the shape the relay short-circuits on:
		// a reply is already written, so the reaction costs no second iteration.
		chunks.push({
			...base,
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: 'call_react_mock',
								type: 'function',
								function: {
									name: 'react_to_message',
									arguments: JSON.stringify({ emoji: REACTION_EMOJI }),
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		});
	}
	chunks.push({
		...base,
		choices: [{ index: 0, delta: {}, finish_reason: react ? 'tool_calls' : 'stop' }],
	});
	chunks.push({
		...base,
		choices: [],
		usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
	});

	let i = 0;
	const tick = () => {
		if (i < chunks.length) {
			res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
			i++;
			setTimeout(tick, delay);
		} else {
			res.write('data: [DONE]\n\n');
			res.end();
		}
	};
	tick();
}

function syncChatCompletion(res, text = REPLY_TEXT) {
	sendJson(res, 200, {
		id: 'chatcmpl-mock',
		object: 'chat.completion',
		model: 'mock-chat',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: text },
				finish_reason: 'stop',
			},
		],
		usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
	});
}

/** Last POST /v1/images/generations body fields a spec cares about. */
let lastImageRequest = null;

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
	const path = url.pathname;

	if (req.method === 'GET' && path === '/v1/models') {
		return sendJson(res, 200, MODELS);
	}

	if (req.method === 'POST' && path === '/v1/chat/completions') {
		const raw = await readBody(req);
		let wantsStream = false;
		let model = 'mock-chat';
		let text = REPLY_TEXT;
		let glacial = false;
		let react = false;
		let suppressText = false;
		try {
			const body = JSON.parse(raw || '{}');
			wantsStream = body.stream === true;
			if (typeof body.model === 'string') model = body.model;
			glacial = wantsGlacialStream(body);
			react = wantsReaction(body);
			// Textless-reaction turn: iteration 1 is the bare tool call, iteration 2
			// (recognized by the tool result already being in the history) is the
			// reply, with no second reaction.
			if (react && wantsTextlessReaction(body)) {
				if (isPostToolIteration(body)) react = false;
				else suppressText = true;
			}
			// A compaction request gets the deterministic summary; everything
			// else gets the normal reply. The empty-summary sentinel (planted in a
			// folded turn) forces a blank summary to exercise the failure path.
			if (isSummarizationRequest(body)) text = wantsEmptySummary(body) ? '' : SUMMARY_TEXT;
		} catch {
			/* default to sync, default model, normal reply */
		}
		return wantsStream
			? streamChatCompletion(res, model, text, glacial, react, suppressText)
			: syncChatCompletion(res, text);
	}

	if (req.method === 'POST' && path === '/v1/images/generations') {
		const raw = await readBody(req);
		// Echo the requested aspect ratio back the way the bridge does, and record
		// it on the probe below — that's the only place a spec can observe that the
		// composer's selection reached the wire at all.
		let requestedRatio = null;
		try {
			requestedRatio = JSON.parse(raw)?.aspect_ratio ?? null;
		} catch {
			/* leave null */
		}
		lastImageRequest = { aspect_ratio: requestedRatio };
		return sendJson(res, 200, {
			created: Math.floor(Date.now() / 1000),
			data: [
				requestedRatio
					? { b64_json: PNG_1X1_B64, aspect_ratio: requestedRatio }
					: { b64_json: PNG_1X1_B64 },
			],
		});
	}

	// Probe for the last image request's non-standard fields, so a spec can assert
	// what GlyphStream actually sent without parsing server logs.
	if (req.method === 'GET' && path === '/__last-image-request') {
		return sendJson(res, 200, lastImageRequest ?? {});
	}

	sendJson(res, 404, { error: { message: `mock upstream: no handler for ${req.method} ${path}` } });
});

server.listen(PORT, () => {
	console.log(`[mock-upstream] listening on http://localhost:${PORT}`);
});
