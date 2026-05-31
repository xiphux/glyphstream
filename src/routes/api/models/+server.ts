import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listEndpoints } from '$lib/server/endpoints/registry';
import { ConfigError } from '$lib/server/endpoints/config';
import { listAllModelsWithErrors } from '$lib/server/endpoints/list-models';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);

	// Surface a ConfigError as a 500 here (rather than degrading to []
	// like listAllModels does) — this endpoint is queried directly when
	// the user is troubleshooting endpoint setup, and "we hid the
	// config problem" is a worse UX than the explicit error.
	try {
		listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) {
			throw error(500, `Endpoint configuration is invalid: ${e.message}`);
		}
		throw e;
	}

	const results = await listAllModelsWithErrors();
	const allModels = results.flatMap((r) => r.models);
	const errors = results
		.filter((r) => r.error)
		.map((r) => ({ endpointId: r.endpointId, error: r.error }));

	return json({
		object: 'list',
		data: allModels,
		// Per-endpoint errors surface here so a single broken upstream
		// doesn't hide the others' models. Frontend can show a banner.
		endpoint_errors: errors,
	});
};
