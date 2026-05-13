// See https://svelte.dev/docs/kit/types#app.d.ts
import type { SessionUser } from '$lib/server/auth/session';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: SessionUser | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	// Build-time-injected constant from vite.config.ts. The value is the
	// `version` field of package.json at build time; lets the sidebar
	// surface a small version indicator without a runtime fs read.
	const __APP_VERSION__: string;
}

export {};
