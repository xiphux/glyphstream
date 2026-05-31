import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
	},
	kit: {
		// precompress: build-time gzip + brotli for every static asset.
		// adapter-node's sirv serves the right one based on Accept-Encoding,
		// no per-request CPU cost. A reverse proxy in front (Caddy/Nginx)
		// can also pick up the .gz/.br variants directly via try_files.
		adapter: adapter({ precompress: true }),

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
				// If you edit that inline script, this hash goes stale and
				// the browser console will print the new expected hash in
				// the next CSP violation report — copy it back here.
				'script-src': ['self', 'sha256-zDStjHdKrEZbvvMjU3DTG6VQNdNJybPV2z/de+vq88A='],
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
	},
};

export default config;
