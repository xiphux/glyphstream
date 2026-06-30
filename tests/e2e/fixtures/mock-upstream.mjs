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

/** A real, decodable 1x1 PNG — the media persister hands bytes to sharp
 *  for thumbnailing, so the b64 must be a valid image, not arbitrary
 *  bytes. */
const PNG_1X1_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
		},
	],
};

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

/** Emit the fixed reply as OpenAI chat-completion SSE chunks: a role
 *  chunk, one chunk per word, a finish chunk, a usage chunk, then
 *  [DONE]. Matches what PassthroughNormalizer expects. */
function streamChatCompletion(res, model, text = REPLY_TEXT) {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-store',
		Connection: 'keep-alive',
	});
	const id = 'chatcmpl-mock';
	const base = { id, object: 'chat.completion.chunk', model: model ?? 'mock-chat' };
	const delay = model === 'mock-chat-slow' ? SLOW_CHUNK_DELAY_MS : FAST_CHUNK_DELAY_MS;

	const chunks = [];
	chunks.push({
		...base,
		choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
	});
	for (const word of text.split(' ')) {
		// Re-attach the space the split removed (except it lands as a
		// leading space on each word after the first, which renders fine).
		const piece = chunks.length === 1 ? word : ` ${word}`;
		chunks.push({
			...base,
			choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
		});
	}
	chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
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
		try {
			const body = JSON.parse(raw || '{}');
			wantsStream = body.stream === true;
			if (typeof body.model === 'string') model = body.model;
			// A compaction request gets the deterministic summary; everything
			// else gets the normal reply. The empty-summary sentinel (planted in a
			// folded turn) forces a blank summary to exercise the failure path.
			if (isSummarizationRequest(body)) text = wantsEmptySummary(body) ? '' : SUMMARY_TEXT;
		} catch {
			/* default to sync, default model, normal reply */
		}
		return wantsStream ? streamChatCompletion(res, model, text) : syncChatCompletion(res, text);
	}

	if (req.method === 'POST' && path === '/v1/images/generations') {
		await readBody(req);
		return sendJson(res, 200, {
			created: Math.floor(Date.now() / 1000),
			data: [{ b64_json: PNG_1X1_B64 }],
		});
	}

	sendJson(res, 404, { error: { message: `mock upstream: no handler for ${req.method} ${path}` } });
});

server.listen(PORT, () => {
	console.log(`[mock-upstream] listening on http://localhost:${PORT}`);
});
