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
	},
};

export default config;
