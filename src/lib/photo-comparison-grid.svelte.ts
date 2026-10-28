/**
 * A photo comparison as a fan-out grid: the develop dialog shows its results
 * in the same `FanoutColumns` a media fan-out uses, and the lightbox triages
 * them the same way (see `TriageSource`) — star, re-roll, trash, and pick the
 * one to show.
 *
 * The columns are derived, not kept: a result is a version of the photo
 * (`ChatMessage.images`) that wasn't there when the comparison started, and a
 * draw still out is a placeholder. Each action is the version's own: re-roll
 * is another draw from that column's model in the same comparison, trash is
 * the image's delete (Recently deleted can bring it back), and the pick puts
 * it on show and counts the comparison in model stats.
 */
import { SvelteSet } from 'svelte/reactivity';
import type { AvatarDrawWorkflow } from './avatar-draw-workflow.svelte.js';
import type { TriageSource } from './chat-lightbox.svelte.js';
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
		const out = c.pending.map((modelId, i) => this.#pendingColumn(c.id, modelId, i));
		return [...landed, ...out];
	});

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

	async discard(col: FanoutColumn): Promise<boolean> {
		const image = this.#imageOf(col);
		if (!image || this.picking) return false;
		this.picking = true;
		try {
			const replyId = this.#deps.workflow.photoComparison?.replyId;
			if (image.mediaId && replyId) await this.#deps.workflow.removePhoto(replyId, image);
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
		const part: MessagePart | null = image.mediaId
			? {
					type: 'image',
					mediaId: image.mediaId,
					...(image.aspectRatio ? { aspectRatio: image.aspectRatio } : {}),
					...(image.width && image.height ? { width: image.width, height: image.height } : {}),
				}
			: null;
		return {
			...this.#base(image.id, image.modelId),
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

	#pendingColumn(comparisonId: string, modelId: string, i: number): FanoutColumn {
		return {
			...this.#base(`${comparisonId}:pending:${i}`, modelId),
			status: 'streaming',
			statusLabel: 'Developing…',
			aspectRatio: null,
			persisted: null,
			error: null,
		};
	}

	#base(branchId: string, modelId: string) {
		return {
			branchId,
			modelId,
			modelKind: 'image' as const,
			label: this.#deps.modelLabel(modelId),
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
}
