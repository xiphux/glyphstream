// See https://svelte.dev/docs/kit/types#app.d.ts
import type { SessionUser } from '$lib/server/auth/session';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: SessionUser | null;
			/**
			 * The sha256 of the presented session token, or null when
			 * unauthenticated. Lets /settings/security mark which row in the
			 * device list is the one you're reading it on, and lets
			 * "sign out everywhere else" spare it.
			 */
			sessionId: string | null;
			/**
			 * Milliseconds this request spent inside synchronous SQLite, summed
			 * across every load that opted in via `timeDb` — which is not every
			 * load. Zero therefore means no WRAPPED query ran, NOT that the request
			 * touched no database — coverage is opt-in per call site, so this is a
			 * floor. See db-timing.ts. Undefined until the first wrapped query, and
			 * the hook reports undefined as zero, which carries the same caveat.
			 */
			dbMs?: number;
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
