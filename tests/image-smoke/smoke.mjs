/**
 * Runs INSIDE the built runtime image (mounted into /app, so imports resolve
 * against the image's own production node_modules). CI's "Docker image smoke"
 * job executes it after the container has booted and served a page.
 *
 * What only this can catch: the image installs `--prod --ignore-scripts` on
 * Alpine/musl, while every other CI job runs a full dev install on glibc. A
 * runtime dependency that isn't in `dependencies`, a musl prebuilt that fails to
 * load (sharp's @img/sharp-linuxmusl-*), or a package whose entry point moved
 * would pass unit and e2e and break the shipped image. Each check does a small
 * piece of REAL work with the library, not just an import.
 */
import process from 'node:process';

const checks = {
	async sharp() {
		const { default: sharp } = await import('sharp');
		const png = await sharp({
			create: { width: 64, height: 32, channels: 3, background: '#7c3aed' },
		})
			.png()
			.toBuffer();
		const jpeg = await sharp(png).resize({ width: 16 }).jpeg({ mozjpeg: true }).toBuffer();
		const meta = await sharp(jpeg).metadata();
		if (meta.format !== 'jpeg' || meta.width !== 16) {
			throw new Error(`unexpected thumbnail: ${meta.format} ${meta.width}px`);
		}
	},

	async pyodide() {
		const { loadPyodide } = await import('pyodide');
		const py = await loadPyodide();
		const out = py.runPython('sum(range(10))');
		if (out !== 45) throw new Error(`runPython returned ${String(out)}`);
	},

	async mcpSdk() {
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const { StreamableHTTPClientTransport } =
			await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
		const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
		const client = new Client({ name: 'image-smoke', version: '0.0.0' });
		new StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'));
		new StdioClientTransport({ command: 'true' });
		if (typeof client.connect !== 'function') throw new Error('Client.connect missing');
	},

	async webPush() {
		const { default: webpush } = await import('web-push');
		const keys = webpush.generateVAPIDKeys();
		webpush.setVapidDetails('mailto:smoke@example.com', keys.publicKey, keys.privateKey);
	},

	async simplewebauthn() {
		const { generateRegistrationOptions } = await import('@simplewebauthn/server');
		const opts = await generateRegistrationOptions({
			rpName: 'smoke',
			rpID: 'localhost',
			userName: 'smoke',
			attestationType: 'none',
		});
		if (!opts.challenge) throw new Error('no challenge');
	},

	async shiki() {
		const { createHighlighter } = await import('shiki');
		const hl = await createHighlighter({ themes: ['github-dark'], langs: ['python'] });
		const html = hl.codeToHtml('print(1)', { lang: 'python', theme: 'github-dark' });
		if (!html.includes('class="shiki')) throw new Error('no shiki markup');
	},

	async markdownIt() {
		const { default: MarkdownIt } = await import('markdown-it');
		const html = new MarkdownIt().render('# hi');
		if (!html.includes('<h1>')) throw new Error(html);
	},

	async readability() {
		const { parseHTML } = await import('linkedom');
		const { Readability } = await import('@mozilla/readability');
		const { document } = parseHTML(
			`<html><head><title>T</title></head><body><article><h1>Heading</h1>${'<p>Body text that is long enough to count as content. </p>'.repeat(20)}</article></body></html>`,
		);
		const article = new Readability(document).parse();
		if (!article?.textContent?.includes('Body text')) throw new Error('no article text');
	},

	async configParsers() {
		const { parse: parseToml } = await import('smol-toml');
		const { parse: parseYaml } = await import('yaml');
		if (parseToml('a = 1').a !== 1) throw new Error('smol-toml');
		if (parseYaml('a: 1').a !== 1) throw new Error('yaml');
	},

	async sseParser() {
		const { createParser } = await import('eventsource-parser');
		let data = '';
		createParser({ onEvent: (e) => (data = e.data) }).feed('data: ok\n\n');
		if (data !== 'ok') throw new Error(`eventsource-parser got "${data}"`);
	},
};

let failed = 0;
for (const [name, run] of Object.entries(checks)) {
	const started = Date.now();
	try {
		await run();
		console.log(`ok   ${name} (${Date.now() - started}ms)`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
	}
}
if (failed > 0) {
	console.log(`${failed} check(s) failed`);
	process.exit(1);
}
console.log('all image checks passed');
