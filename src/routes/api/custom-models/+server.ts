import { requireUser } from '#lib/server/auth/guard.js';
import { parseJsonBody } from '#lib/server/http.js';
import {
	createCustomModel,
	listCustomModelsForUser,
} from '#lib/server/db/queries/custom-models.js';
import { validateCreateInput } from '#lib/server/custom-models/validate.js';
import type { CreateCustomModelRequest } from '#lib/types/api.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return Response.json({ customModels: listCustomModelsForUser(locals.user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<CreateCustomModelRequest>(request);

	const validated = validateCreateInput(body);
	const model = createCustomModel({
		userId: locals.user.id,
		name: validated.name,
		description: validated.description,
		baseEndpointId: validated.baseEndpointId,
		baseModelId: validated.baseModelId,
		systemPrompt: validated.systemPrompt,
		parameters: validated.parameters,
		defaultDisabledFeatures: validated.defaultDisabledFeatures,
		replyStyle: validated.replyStyle,
		checkIns: validated.checkIns,
		photos: validated.photos,
	});
	return Response.json({ customModel: model }, { status: 201 });
};
