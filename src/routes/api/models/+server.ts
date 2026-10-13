import { error } from '@sveltejs/kit';
import { MAX_MODEL_IDS_PER_REQUEST } from '#lib/model-ids.js';
import { parseModelId } from '#lib/server/endpoints/model-id.js';
import { requireUser } from '#lib/server/auth/guard.js';
import { listEndpoints } from '#lib/server/endpoints/registry.js';
import { ConfigError } from '#lib/server/endpoints/config.js';
import {
	endpointErrorForViewer,
	listAllModelsWithErrors,
} from '#lib/server/endpoints/list-models.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	requireUser(locals);

	// Surface a ConfigError as a 500 here (rather than degrading to []
	// like listAllModels does) — this endpoint is queried directly when
	// the user is troubleshooting endpoint setup, and "we hid the
	// config problem" is a worse UX than the explicit error.
	try {
		listEndpoints();
	} catch (e) {
		if (e instanceof ConfigError) {
			// Only the env var NAME is ever in the detail, never a resolved value
			// (the *_env convention), so this is path/name disclosure, not a
			// credential leak; endpointErrorForViewer still keeps it to admins.
			error(
				500,
				endpointErrorForViewer(
					locals.user.role,
					'config',
					`Endpoint configuration is invalid: ${e.message}`,
				),
			);
		}
		throw e;
	}

	const results = await listAllModelsWithErrors();
	const allModels = results.flatMap((r) => r.models);
	const role = locals.user.role;
	const viewerError = (message: string) => endpointErrorForViewer(role, 'listing', message);

	// `?ids=a,b,c` — resolve specific models without shipping the catalogue.
	//
	// The client holds only a first-paint slice of the model list (see the (app)
	// layout), so it periodically meets an id it can't render: the model of a
	// conversation it just opened, the cart a "new chat from this prompt" intent
	// restored. This answers exactly those, off the same in-memory cache the full
	// listing uses.
	//
	// Unknown ids are simply absent from the response rather than an error. That
	// distinction is the whole point of asking: a caller sending three ids and
	// receiving two has learned that the third is genuinely not configured — which
	// is a real answer, and the one a stale favourite or a removed endpoint
	// produces. `endpoint_errors` below is what keeps that inference honest when
	// the endpoint was merely unreachable.
	const idsParam = url.searchParams.get('ids');
	if (idsParam !== null) {
		const wanted = new Set(
			idsParam
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean)
				.slice(0, MAX_MODEL_IDS_PER_REQUEST),
		);
		// Errors for the endpoints these ids actually name, and only those.
		//
		// NOT empty, and not the whole list either. The caller uses an absence as an
		// answer — "asked, didn't come back, therefore not configured" — and caches
		// it. That inference is only sound when the endpoint that would have
		// answered was reachable: `listAllModelsWithErrors` degrades a cold, failing
		// endpoint to zero models, which is indistinguishable from "no such model"
		// unless we say so here. Scoping to the named endpoints keeps an unrelated
		// upstream's outage from poisoning a lookup that had nothing to do with it.
		// Through the canonical parser, not a hand-rolled `indexOf`: an id with no
		// separator (an OWUI import's bare `gpt-4o`) makes `slice(0, -1)` return the
		// id minus its last character, which is a silent collision waiting on an
		// endpoint that happens to be named that.
		const wantedEndpoints = new Set(
			[...wanted].map((id) => parseModelId(id)?.endpointId).filter((e) => e !== undefined),
		);
		return Response.json({
			object: 'list',
			data: allModels.filter((m) => wanted.has(m.id)),
			endpoint_errors: results
				.filter((r) => r.error && wantedEndpoints.has(r.endpointId))
				.map((r) => ({ endpointId: r.endpointId, error: viewerError(r.error!) })),
		});
	}
	const errors = results
		.filter((r) => r.error)
		.map((r) => ({ endpointId: r.endpointId, error: viewerError(r.error!) }));

	return Response.json({
		object: 'list',
		data: allModels,
		// Per-endpoint errors surface here so a single broken upstream
		// doesn't hide the others' models. Frontend can show a banner.
		endpoint_errors: errors,
	});
};
