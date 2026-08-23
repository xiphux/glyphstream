import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listEndpoints } from '$lib/server/endpoints/registry';
import { ConfigError } from '$lib/server/endpoints/config';
import { listAllModelsWithErrors } from '$lib/server/endpoints/list-models';
import type { RequestHandler } from './$types';

/**
 * Ceiling on a single `?ids=` resolve. Not a security boundary — the caller is
 * authenticated and the list is already in memory — but a bounded request is
 * easier to reason about than one whose cost scales with the query string, and
 * every real caller asks for a handful: a conversation's model, a restored
 * compare cart, the models named across one fan-out.
 */
const MAX_IDS = 200;

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
			// The detail names the absolute config.toml path and the env var
			// expected to hold a key — troubleshooting gold for the operator,
			// and infrastructure disclosure to everyone else. (Only the env var
			// NAME, never a resolved value, per the *_env convention — so this
			// is path/name disclosure, not a credential leak.) Admins can
			// already read config.toml; non-admins get the bare fact.
			if (locals.user.role === 'admin') {
				error(500, `Endpoint configuration is invalid: ${e.message}`);
			}
			error(500, 'Endpoint configuration is invalid. Ask an administrator to check it.');
		}
		throw e;
	}

	const results = await listAllModelsWithErrors();
	const allModels = results.flatMap((r) => r.models);

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
	// produces.
	const idsParam = url.searchParams.get('ids');
	if (idsParam !== null) {
		const wanted = new Set(
			idsParam
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean)
				.slice(0, MAX_IDS),
		);
		return json({
			object: 'list',
			data: allModels.filter((m) => wanted.has(m.id)),
			// Deliberately empty. A per-endpoint failure means "this endpoint's models
			// are missing from `data`", which a caller reading the FULL listing needs
			// to know. Here the caller asked about specific ids and is told which
			// resolved; an endpoint being down already shows up as an id that didn't
			// come back, and repeating it as a banner-worthy error would surface
			// unrelated endpoints' problems on an unrelated lookup.
			endpoint_errors: [],
		});
	}
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
