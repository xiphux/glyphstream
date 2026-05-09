/** Shared types between server endpoints and client code. */

/** Non-standard extensions agreed with openai-api-bridge; other upstreams may also set them. */
export type ModelKind = 'chat' | 'embedding' | 'image' | 'video';

/** A model as returned by `GET /api/models` (one row per upstream model, prefixed). */
export interface ModelEntry {
	/** Internal id: `{endpoint_id}::{upstream_model_id}` */
	id: string;
	/** Convenience: which endpoint this model is exposed by */
	endpointId: string;
	/** Convenience: the bare upstream model id (no endpoint prefix) */
	upstreamId: string;
	/** Best display name we have — falls back to upstream id if upstream didn't set display_name */
	displayName: string;
	/** Modality, when known. Defaults to 'chat' (the safest fallback) when upstream didn't set it. */
	kind: ModelKind;
	/** True when upstream actually told us the kind, false when we fell back to default */
	kindKnown: boolean;
}

/** Standard OpenAI /v1/models row, plus the bridge's optional extensions. */
export interface UpstreamModel {
	id: string;
	object?: 'model';
	created?: number;
	owned_by?: string;
	display_name?: string;
	kind?: ModelKind | null;
}
