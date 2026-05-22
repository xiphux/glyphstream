import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import {
	createCustomModel,
	listCustomModelsForUser
} from '$lib/server/db/queries/custom-models';
import { validateCreateInput } from '$lib/server/custom-models/validate';
import type { CreateCustomModelRequest } from '$lib/types/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json({ customModels: listCustomModelsForUser(locals.user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);

	let body: CreateCustomModelRequest;
	try {
		body = (await request.json()) as CreateCustomModelRequest;
	} catch {
		throw error(400, 'Request body must be JSON');
	}

	const validated = validateCreateInput(body);
	const model = createCustomModel({
		userId: locals.user.id,
		name: validated.name,
		description: validated.description,
		baseEndpointId: validated.baseEndpointId,
		baseModelId: validated.baseModelId,
		systemPrompt: validated.systemPrompt,
		parameters: validated.parameters
	});
	return json({ customModel: model }, { status: 201 });
};
