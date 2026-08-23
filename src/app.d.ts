// See https://svelte.dev/docs/kit/types#app.d.ts
import type { SessionUser } from '$lib/server/auth/session';
import type { ModelEntry } from '$lib/types/api';

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
		interface PageData {
			/**
			 * Model entries a route resolved server-side for its own first paint.
			 *
			 * Declared here, rather than left to the route's generated `PageData`,
			 * because the `(app)` LAYOUT reads it off `page.data` to seed the model
			 * catalogue — Svelte memoizes a `$derived` created during SSR, so the
			 * catalogue's index freezes at its first read and a page adopting its own
			 * models afterwards writes into a snapshot nobody looks at again. Seeding
			 * is order-independent; adopting is not.
			 *
			 * Declared rather than cast so the layout's read is typed
			 * (`ModelEntry[] | undefined`) instead of `any`. Note what that does NOT
			 * buy: `page.data` is `App.PageData & Record<string, any>`, so a typo on
			 * the READING side still compiles and silently seeds nothing. A rename on
			 * the supplying side is caught today only because `chat/[id]` also reads
			 * the field through its own generated `PageData`. Optional because only
			 * that route supplies it.
			 */
			referencedModels?: ModelEntry[];
		}
		// interface PageState {}
		// interface Platform {}
	}

	// Build-time-injected constant from vite.config.ts. The value is the
	// `version` field of package.json at build time; lets the sidebar
	// surface a small version indicator without a runtime fs read.
	const __APP_VERSION__: string;
}

export {};
