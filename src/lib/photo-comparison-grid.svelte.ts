/**
 * A photo comparison as a fan-out grid: the develop dialog shows its results
 * in the same `FanoutColumns` a media fan-out uses, and the lightbox triages
 * them the same way (see `TriageSource`) — star, re-roll, trash, and pick the
 * one to show.
 *
 * The columns are derived, not kept: a result is a version of the photo
 * (`ChatMessage.images`) that wasn't there when the comparison started, and a
 * draw still out is a placeholder — one this tab is waiting on, or one the
 * server says is still out (`ChatMessage.developing`), which outlasts the
 * requests a suspended PWA loses. Each action is the version's own: re-roll
 * is another draw from that column's model in the same comparison, trash is
 * the image's delete (Recently deleted can bring it back), and the pick puts
 * it on show and counts the comparison in model stats.
 */
import { SvelteSet } from 'svelte/reactivity';
import type { AvatarDrawWorkflow, PhotoComparison } from './avatar-draw-workflow.svelte.js';
import type { PickLabels, TriageSource } from './chat-lightbox.svelte.js';
import type { FanoutColumn } from './fanout.js';
import type { ChatMessage, MessageImage, MessagePart } from './types/api.js';

export interface PhotoComparisonGridDeps {
	workflow: AvatarDrawWorkflow;
	/** The active branch, which carries the photo's versions. */
	messages(): ChatMessage[];
	/** A model's display name. */
	modelLabel(id: string): string;
}

export class PhotoComparisonGrid implements TriageSource {
	#deps: PhotoComparisonGridDeps;
	readonly isMedia = true;
	readonly reportsOwnErrors = true;
	picking = $state(false);
	/** Failed draws the user cleared from the grid. They have no image to trash,
	 *  and the next attempt at the photo replaces them anyway. */
	#dismissed = new SvelteSet<string>();

	constructor(deps: PhotoComparisonGridDeps) {
		this.#deps = deps;
	}

	/** A comparison is on show in the dialog. */
	get active(): boolean {
		return this.#deps.workflow.photoComparison !== null;
	}

	readonly #results = $derived.by((): MessageImage[] => {
		const c = this.#deps.workflow.photoComparison;
		if (!c) return [];
		const reply = this.#deps.messages().find((m) => m.id === c.replyId);
		return (reply?.images ?? []).filter(
			(i) => i.markerIndex === c.index && !c.before.has(i.id) && !this.#dismissed.has(i.id),
		);
	});

	readonly columns = $derived.by((): FanoutColumn[] => {
		const c = this.#deps.workflow.photoComparison;
		if (!c) return [];
		const landed = this.#results.map((image) => this.#column(image));
		const out = this.#stillOut(c).map((modelId, i) => this.#pendingColumn(c.id, modelId, i));
		return [...landed, ...out];
	});

	/** The comparison's draws still out, a model per draw: as many of each
	 *  model as this tab or the server has, whichever is more — each knows of
	 *  some the other doesn't (one just sent; one whose request was lost). */
	#stillOut(c: PhotoComparison): string[] {
		const reply = this.#deps.messages().find((m) => m.id === c.replyId);
		const out = [...c.pending];
		const unmatched = [...c.pending];
		for (const d of reply?.developing ?? []) {
			if (d.compareId !== c.id) continue;
			const at = unmatched.indexOf(d.modelId);
			if (at === -1) out.push(d.modelId);
			else unmatched.splice(at, 1);
		}
		return out;
	}

	canRegenerate(col: FanoutColumn): boolean {
		return col.status === 'done' || col.status === 'error';
	}

	regenerate(col: FanoutColumn): Promise<void> {
		this.#deps.workflow.developAgainInComparison(col.modelId);
		return Promise.resolve();
	}

	async pick(col: FanoutColumn): Promise<void> {
		const image = this.#imageOf(col);
		if (!image?.mediaId || this.picking) return;
		this.picking = true;
		try {
			const replyId = this.#deps.workflow.photoComparison?.replyId;
			if (replyId) await this.#deps.workflow.showPhoto(replyId, image, true);
		} finally {
			this.picking = false;
		}
	}

	pickLabels(): PickLabels {
		return pickLabels(this.#deps.workflow.photo?.index === null ? 'portrait' : 'photo');
	}

	async discard(col: FanoutColumn): Promise<boolean> {
		const image = this.#imageOf(col);
		if (!image || this.picking) return false;
		this.picking = true;
		try {
			const replyId = this.#deps.workflow.photoComparison?.replyId;
			if (image.mediaId && replyId && !(await this.#deps.workflow.removePhoto(replyId, image))) {
				return false;
			}
			this.#dismissed.add(image.id);
			return true;
		} finally {
			this.picking = false;
		}
	}

	#imageOf(col: FanoutColumn): MessageImage | undefined {
		return this.#results.find((i) => i.id === col.branchId);
	}

	#column(image: MessageImage): FanoutColumn {
		return versionColumn(image, this.#deps.modelLabel(image.modelId));
	}

	#pendingColumn(comparisonId: string, modelId: string, i: number): FanoutColumn {
		return {
			...baseColumn(`${comparisonId}:pending:${i}`, modelId, this.#deps.modelLabel(modelId)),
			status: 'streaming',
			statusLabel: 'Developing…',
			aspectRatio: null,
			persisted: null,
			error: null,
		};
	}
}

/**
 * The photos and portraits on the thread's replies, for the lightbox to triage
 * where no grid is showing them: delete any version, and — for one drawn in a
 * comparison still to be picked from, closed before its pick — the grid's
 * footer: star, pick, delete. That's the comparison triaged where the image is
 * big and its model named, rather than on the reply's small picture.
 */
export class PhotoVersionTriage implements TriageSource {
	#deps: PhotoComparisonGridDeps;
	readonly isMedia = true;
	readonly reportsOwnErrors = true;
	picking = $state(false);

	constructor(deps: PhotoComparisonGridDeps) {
		this.#deps = deps;
	}

	/** Every version with an image, and the reply it's on. */
	readonly #versions = $derived.by(() => {
		const out = new Map<string, { replyId: string; image: MessageImage }>();
		for (const m of this.#deps.messages()) {
			for (const image of m.images ?? []) {
				if (image.mediaId) out.set(image.id, { replyId: m.id, image });
			}
		}
		return out;
	});

	readonly columns = $derived.by((): FanoutColumn[] =>
		[...this.#versions.values()].map(({ image }) =>
			versionColumn(image, this.#deps.modelLabel(image.modelId)),
		),
	);

	/** The grid's footer only for a comparison's result; any other version
	 *  keeps the lightbox's own actions, with Delete among them. */
	triages(col: FanoutColumn): boolean {
		return !!this.#versions.get(col.branchId)?.image.inComparison;
	}

	/** As the reply's own trash allows: any version can go. */
	canDiscard(): boolean {
		return true;
	}

	canRegenerate(): boolean {
		return false;
	}

	regenerate(): Promise<void> {
		return Promise.resolve();
	}

	pickLabels(col: FanoutColumn): PickLabels | null {
		const v = this.#versions.get(col.branchId);
		return v?.image.inComparison ? pickLabels(v.image.kind) : null;
	}

	async pick(col: FanoutColumn): Promise<void> {
		const v = this.#versions.get(col.branchId);
		if (!v?.image.inComparison || this.picking) return;
		this.picking = true;
		try {
			await this.#deps.workflow.showPhoto(v.replyId, v.image, true);
		} finally {
			this.picking = false;
		}
	}

	async discard(col: FanoutColumn): Promise<boolean> {
		const v = this.#versions.get(col.branchId);
		if (!v || this.picking) return false;
		this.picking = true;
		try {
			return await this.#deps.workflow.removePhoto(v.replyId, v.image);
		} finally {
			this.picking = false;
		}
	}
}

function pickLabels(kind: MessageImage['kind']): PickLabels {
	return kind === 'portrait'
		? { label: 'Use this avatar', caption: 'Use avatar' }
		: { label: 'Show this one', caption: 'Show' };
}

/** A version as a grid column: done, or failed. */
function versionColumn(image: MessageImage, label: string): FanoutColumn {
	const part: MessagePart | null = image.mediaId
		? {
				type: 'image',
				mediaId: image.mediaId,
				...(image.aspectRatio ? { aspectRatio: image.aspectRatio } : {}),
				...(image.width && image.height ? { width: image.width, height: image.height } : {}),
			}
		: null;
	return {
		...baseColumn(image.id, image.modelId, label),
		status: image.mediaId ? 'done' : 'error',
		aspectRatio: image.aspectRatio,
		persisted: part
			? {
					id: image.id,
					role: 'assistant',
					parts: [part],
					contentHtml: null,
					reasoningText: null,
					finishReason: null,
					modelUsed: image.modelId,
					tokensIn: null,
					tokensOut: null,
					genMs: null,
					createdAt: image.createdAt,
				}
			: null,
		error: image.error,
	};
}

function baseColumn(branchId: string, modelId: string, label: string) {
	return {
		branchId,
		modelId,
		modelKind: 'image' as const,
		label,
		segments: [],
		queuedAhead: 0,
		dispatching: false,
		progress: null,
		statusLabel: null,
		startedAt: null,
		inputMediaId: null,
		dispatchIndex: null,
		errorMessageId: null,
	};
}
