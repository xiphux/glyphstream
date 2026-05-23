import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	// The (app) layout loads `models` + `customModels` (for the sidebar's
	// favorites resolution); this page just inherits them so its picker
	// renders with the same data without re-running the upstream fetch
	// loop. Auth + locals.user!.id deref happens in the layout — `await
	// parent()` ensures any redirect/error there wins before we'd touch it.
	await parent();
	return {};
};
