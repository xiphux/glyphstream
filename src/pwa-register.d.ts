/**
 * Ambient declaration for `virtual:pwa-register`, the module vite-plugin-pwa
 * generates at build time.
 *
 * The plugin ships this declaration itself, but it reaches us only as a
 * transitive dependency of `@vite-pwa/sveltekit`, so under pnpm's strict
 * node_modules layout it isn't resolvable from the project root and a
 * `/// <reference types="vite-plugin-pwa/client" />` can't find it either.
 *
 * This file deliberately has no imports or exports: that keeps it a script
 * rather than a module, which is what makes `declare module` an ambient
 * declaration instead of an augmentation of a module that doesn't exist.
 * (Putting it in app.d.ts does NOT work for that reason.)
 *
 * Mirrors the plugin's own `vanillajs.d.ts`.
 */
declare module 'virtual:pwa-register' {
	export interface RegisterSWOptions {
		immediate?: boolean;
		/** Fires when the SW has taken control and the page would normally reload. */
		onNeedReload?: () => void;
		onNeedRefresh?: () => void;
		onOfflineReady?: () => void;
		/** @deprecated Upstream prefers `onRegisteredSW`. */
		onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
		onRegisteredSW?: (
			swScriptUrl: string,
			registration: ServiceWorkerRegistration | undefined,
		) => void;
		onRegisterError?: (error: unknown) => void;
	}

	/** Returns a callback that triggers the waiting service worker to activate. */
	export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
