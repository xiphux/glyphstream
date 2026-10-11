import { WEB_MANIFEST_JSON } from '#lib/web-manifest.js';

// Not prerendered: as a dynamic route it passes through `handle`, which marks it
// `no-cache` (ALWAYS_REVALIDATE_PATHS in hooks.server.ts) so a proxy can't pin
// an old manifest. The body is a constant, so this costs one string write.
export function GET() {
	return new Response(WEB_MANIFEST_JSON, {
		headers: { 'content-type': 'application/manifest+json' },
	});
}
