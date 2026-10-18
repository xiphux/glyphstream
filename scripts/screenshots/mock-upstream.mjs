/**
 * Mock OpenAI-compatible upstream for README screenshot capture.
 *
 * Like tests/e2e/fixtures/mock-upstream.mjs, but serves *realistic* model
 * catalogs so the picker, sidebar favorites, and fan-out labels look like
 * a real deployment instead of "mock-chat". One process fronts all three
 * demo endpoints, routed by path prefix:
 *
 *   /workstation/v1/...   local llama.cpp box (chat models)
 *   /groq/v1/...          hosted provider (chat models)
 *   /bridge/v1/...        openai-api-bridge (image/video, owned_by groups)
 *
 * Screenshots are of *persisted* conversations, so chat/image generation
 * handlers exist only as a courtesy (a fixed reply / 1x1 PNG) — nothing in
 * the capture flow sends new messages.
 */

import process from 'node:process';
import { createServer } from 'node:http';

const PORT = Number(process.env.DEMO_UPSTREAM_PORT ?? 3002);

const RATIOS = [
	{ value: '1:1', label: 'Square' },
	{ value: '4:3', label: 'Landscape' },
	{ value: '16:9', label: 'Widescreen' },
	{ value: '3:4', label: 'Portrait' },
	{ value: '9:16', label: 'Tall' },
];

const CATALOGS = {
	workstation: [
		// meta.n_ctx is llama.cpp's configured context — it's what lets the
		// composer's context bar show `used / window`.
		{
			id: 'llama-3.3-70b-instruct',
			display_name: 'Llama 3.3 70B',
			kind: 'chat',
			meta: { n_ctx: 32768 },
		},
		{
			id: 'qwen2.5-coder-32b-instruct',
			display_name: 'Qwen2.5 Coder 32B',
			kind: 'chat',
			meta: { n_ctx: 32768 },
		},
		{
			id: 'deepseek-r1-distill-qwen-32b',
			display_name: 'DeepSeek-R1 32B',
			kind: 'chat',
			meta: { n_ctx: 32768 },
		},
	],
	groq: [
		{ id: 'llama-3.1-8b-instant', display_name: 'Llama 3.1 8B Instant', kind: 'chat' },
		{ id: 'llama-3.3-70b-versatile', display_name: 'Llama 3.3 70B Versatile', kind: 'chat' },
	],
	bridge: [
		// `capabilities` drives the picker's modality pills (T2I / I2I / TI2V);
		// `aspect_ratios` drives the composer's aspect-ratio picker.
		{
			id: 'flux-dev',
			display_name: 'FLUX.1 dev',
			kind: 'image',
			owned_by: 'comfyui',
			capabilities: ['text-to-image'],
			aspect_ratios: RATIOS,
			aspect_ratio_default: '1:1',
		},
		{
			id: 'flux-kontext',
			display_name: 'FLUX.1 Kontext',
			kind: 'image',
			owned_by: 'comfyui',
			capabilities: ['image-to-image'],
			aspect_ratios: RATIOS,
		},
		{
			id: 'flux-schnell',
			display_name: 'FLUX.1 schnell',
			kind: 'image',
			owned_by: 'comfyui',
			capabilities: ['text-to-image'],
			aspect_ratios: RATIOS,
			aspect_ratio_default: '1:1',
		},
		{
			id: 'ltx-video',
			display_name: 'LTX Video',
			kind: 'video',
			owned_by: 'comfyui',
			capabilities: ['text-to-video', 'image-to-video'],
			aspect_ratios: [RATIOS[2], RATIOS[4]],
		},
		{
			id: 'venice-sd35',
			display_name: 'Venice SD3.5',
			kind: 'image',
			owned_by: 'venice',
			capabilities: ['text-to-image'],
			aspect_ratios: RATIOS,
			aspect_ratio_default: '1:1',
		},
	],
};

const PNG_1X1_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function sendJson(res, status, obj) {
	const payload = JSON.stringify(obj);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
	const m = url.pathname.match(/^\/(workstation|groq|bridge)\/v1\/(.+)$/);
	if (!m) return sendJson(res, 404, { error: { message: `no handler for ${url.pathname}` } });
	const [, endpoint, rest] = m;

	if (req.method === 'GET' && rest === 'models') {
		return sendJson(res, 200, {
			object: 'list',
			data: CATALOGS[endpoint].map((x) => ({ object: 'model', owned_by: endpoint, ...x })),
		});
	}
	if (req.method === 'POST' && rest === 'chat/completions') {
		return sendJson(res, 200, {
			id: 'chatcmpl-demo',
			object: 'chat.completion',
			choices: [
				{ index: 0, message: { role: 'assistant', content: 'Demo reply.' }, finish_reason: 'stop' },
			],
			usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
		});
	}
	if (req.method === 'POST' && rest === 'images/generations') {
		return sendJson(res, 200, {
			created: Math.floor(Date.now() / 1000),
			data: [{ b64_json: PNG_1X1_B64 }],
		});
	}
	sendJson(res, 404, { error: { message: `no handler for ${req.method} ${url.pathname}` } });
});

server.listen(PORT, () => {
	console.log(`[demo-upstream] listening on http://localhost:${PORT}`);
});
