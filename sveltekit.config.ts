/**
 * SvelteKit's options, shared by every Vite config that runs the `sveltekit()`
 * plugin: vite.config.ts, vitest.config.ts and vitest.eval.config.ts.
 *
 * SvelteKit 3 reads these from the plugin call and refuses a svelte.config.js,
 * so without one shared object the test configs would each call a bare
 * `sveltekit()` — and compile components without the `runes` option the app
 * builds with, a difference no test would notice until it mattered.
 */
import adapter from '@sveltejs/adapter-node';
import type { sveltekit } from '@sveltejs/kit/vite';

export const sveltekitOptions: Parameters<typeof sveltekit>[0] = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
	},
	// precompress: build-time gzip + brotli for every static asset.
	// adapter-node serves the right one based on Accept-Encoding,
	// no per-request CPU cost. A reverse proxy in front (Caddy/Nginx)
	// can also pick up the .gz/.br variants directly via try_files.
	adapter: adapter({ precompress: true }),

	// SvelteKit builds src/service-worker.ts, but registration is ours:
	// #lib/sw/register.ts, from the root layout. Kit's own registration is
	// a bare `register()` in every page's inline script, with none of the
	// update-prompt wiring, so left on it would race ours for the same URL.
	serviceWorker: { register: false },

	// SvelteKit's own CSRF origin check is off; the app's gate in
	// hooks.server.ts is the one that runs. Since SvelteKit 3 Kit's check also
	// refuses BODY-LESS mutations (a DELETE, an empty POST) whose Origin differs
	// from the origin Kit infers for itself — and adapter-node infers `https` +
	// the Host header. That is wrong over plain http (local and LAN installs, the
	// e2e server) and behind any proxy that doesn't forward Host (nginx's default
	// proxy_pass), so every delete in the app 403'd there. The app's gate keys
	// off the browser-set Sec-Fetch-Site precisely to be immune to that —
	// browsers send it only to secure targets, so over plain http the gate
	// compares Origin with EXTERNAL_BASE_URL instead of the inferred origin —
	// and covers more: every mutating /api request, JSON included, which Kit's check
	// never inspected. It reaches only /api/*, so
	// tests/unit/csrf-gate-coverage.test.ts fails if a mutating route — or a form
	// action — ever appears anywhere else.
	csrf: { trustedOrigins: ['*'] },

	// Content-Security-Policy — defense in depth against any XSS that
	// slips past our explicit sinks (markdown-it runs with `html: false`
	// and the three `{@html}` sites all hold server-controlled HTML,
	// but a real CSP raises the cost of any future mistake by an order
	// of magnitude).
	//
	// mode: 'auto' — SvelteKit scans the rendered HTML for inline
	// <script>/<style> blocks and adds their hashes (for prerendered
	// routes) or per-response nonces (for dynamic SSR). That covers
	// SvelteKit's own hydration script AND the IIFEs in app.html that
	// resolve color scheme / GPU blur pre-paint.
	//
	// 'unsafe-inline' on style-src is required because of three inline
	// `style="..."` attributes (composer padding, two safe-area
	// insets) plus the `style="display: contents"` wrapper app.html
	// puts around %sveltekit.body%. Inline style ATTRIBUTES can't be
	// hashed or nonced — only `<style>` blocks can — so 'unsafe-inline'
	// is unavoidable without a refactor for marginal gain. Style-based
	// XSS is a narrow class (mostly CSS exfiltration via :target /
	// attribute selectors); the script-src lockdown is the
	// load-bearing protection here.
	//
	// connect-src 'self': every API call (streaming SSE included) is
	// same-origin — outbound calls to upstream LLMs / search go through
	// the server's relay, not direct from the browser. img-src adds
	// `data:` (cheap future-proofing) and `blob:` (the composer's
	// `URL.createObjectURL` previews of attachments before upload).
	// media-src adds `blob:` for the same composer preview path on
	// videos. frame-ancestors 'none' pairs with the X-Frame-Options:
	// DENY header set in hooks.server.ts.
	csp: {
		mode: 'auto',
		directives: {
			'default-src': ['self'],
			// The sha256 below pins the inline <script> in src/app.html
			// (the pre-paint color-scheme + GPU-blur IIFEs). SvelteKit's
			// CSP nonces its own injected scripts but does NOT
			// auto-hash user-authored inline scripts in app.html, so
			// without this pin the dev server refuses to execute it
			// (and dropping it to an external file would cost a
			// render-blocking request and reintroduce a FOUC window).
			//
			// If you edit that inline script, this hash goes stale and the
			// script is silently BLOCKED — the page still works, because the
			// layout re-applies the scheme after hydration, so the only
			// symptom is the FOUC this pin exists to prevent, plus a blur
			// probe that never runs. It went stale once exactly that way.
			// `tests/unit/csp-inline-script-hash.test.ts` recomputes it from
			// app.html and fails with the value to paste here.
			'script-src': ['self', 'sha256-Ar3Hg1mVpvhki2BhDuALtdbJXW94wX8y3ugNbQnpA3A='],
			'style-src': ['self', 'unsafe-inline'],
			'img-src': ['self', 'data:', 'blob:'],
			'media-src': ['self', 'blob:'],
			'connect-src': ['self'],
			'font-src': ['self', 'data:'],
			'worker-src': ['self'],
			'object-src': ['none'],
			'base-uri': ['self'],
			'form-action': ['self'],
			'frame-ancestors': ['none'],
			'frame-src': ['none'],
		},
	},
};
