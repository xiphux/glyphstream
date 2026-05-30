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
			supports_tools: false
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
			supports_tools: false
		},
		{
			id: 'mock-image',
			object: 'model',
			kind: 'image',
			display_name: 'Mock Image',
			owned_by: 'mock'
		}
	]
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
		'Content-Length': Buffer.byteLength(payload)
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
function streamChatCompletion(res, model) {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-store',
		Connection: 'keep-alive'
	});
	const id = 'chatcmpl-mock';
	const base = { id, object: 'chat.completion.chunk', model: model ?? 'mock-chat' };
	const delay = model === 'mock-chat-slow' ? SLOW_CHUNK_DELAY_MS : FAST_CHUNK_DELAY_MS;

	const chunks = [];
	chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
	for (const word of REPLY_TEXT.split(' ')) {
		// Re-attach the space the split removed (except it lands as a
		// leading space on each word after the first, which renders fine).
		const piece = chunks.length === 1 ? word : ` ${word}`;
		chunks.push({
			...base,
			choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
		});
	}
	chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
	chunks.push({
		...base,
		choices: [],
		usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
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

function syncChatCompletion(res) {
	sendJson(res, 200, {
		id: 'chatcmpl-mock',
		object: 'chat.completion',
		model: 'mock-chat',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: REPLY_TEXT },
				finish_reason: 'stop'
			}
		],
		usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
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
		try {
			const body = JSON.parse(raw || '{}');
			wantsStream = body.stream === true;
			if (typeof body.model === 'string') model = body.model;
		} catch {
			/* default to sync, default model */
		}
		return wantsStream ? streamChatCompletion(res, model) : syncChatCompletion(res);
	}

	if (req.method === 'POST' && path === '/v1/images/generations') {
		await readBody(req);
		return sendJson(res, 200, {
			created: Math.floor(Date.now() / 1000),
			data: [{ b64_json: PNG_1X1_B64 }]
		});
	}

	sendJson(res, 404, { error: { message: `mock upstream: no handler for ${req.method} ${path}` } });
});

server.listen(PORT, () => {
	console.log(`[mock-upstream] listening on http://localhost:${PORT}`);
});
