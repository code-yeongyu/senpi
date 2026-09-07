import { Container } from "@earendil-works/pi-tui";

/**
 * Tunables for progressive transcript hydration.
 *
 * `tailBudget` is the number of trailing children painted on the first frame:
 * enough to fill the visible viewport, never the whole persisted history.
 * `warmChunkSize` bounds how many earlier children are rendered per macrotask
 * so hydration never blocks input handling.
 */
export type ProgressiveTranscriptOptions = {
	readonly tailBudget: number;
	readonly warmChunkSize: number;
	readonly requestRender: () => void;
};

/** Trailing children painted on the first frame; roughly two tall viewports of messages. */
export const DEFAULT_TAIL_BUDGET = 60 as const;

/** Earlier children warmed per macrotask during background hydration. */
export const DEFAULT_WARM_CHUNK_SIZE = 100 as const;

/** Watermark sentinel: no frame has been painted yet, so nothing is proven renderable. */
const PENDING_FIRST_PAINT = -1 as const;

/**
 * A transcript container that paints a bounded, fully-styled tail on its first
 * frame and warms the earlier history in bounded `setImmediate` chunks.
 *
 * Resuming a long session used to Markdown-render every persisted message
 * before the first paint, so `/resume` blocked for hundreds of milliseconds on
 * work the user could not see. Children are still the real message and tool
 * components and are still rendered by their own `render(width)`, so the
 * visible tail is pixel-identical to the eager path; only the render *order*
 * changes. Once hydration completes the container behaves exactly like its
 * `Container` base, which keeps scrolling, history, and full-transcript output
 * unchanged.
 */
export class ProgressiveTranscriptContainer extends Container {
	private readonly tailBudget: number;
	private readonly warmChunkSize: number;
	private readonly requestRender: () => void;

	/**
	 * Index of the first child published to the TUI. It is fixed to the first
	 * frame's tail boundary until the entire deferred head has warmed, then drops
	 * to zero in one atomic completion repaint.
	 */
	private visibleFrom: number = PENDING_FIRST_PAINT;

	/**
	 * Index of the next deferred child to warm. Unlike `visibleFrom`, this moves
	 * toward zero in background chunks and is never exposed by an incomplete
	 * render.
	 */
	private warmedFrom: number = PENDING_FIRST_PAINT;
	private hydrationScheduled = false;
	private hydrationGeneration = 0;
	/**
	 * Deliberately NOT named `disposed`: `Container` keeps a private `disposed`
	 * own-property guard, and a same-named subclass field lands in the same slot,
	 * so setting it before `super.dispose()` would make the base early-return and
	 * silently skip disposing every child.
	 */
	private hydrationHalted = false;

	/** Width of the last painted frame, reused to warm the head at the real render width. */
	private lastRenderWidth: number | undefined;

	constructor(options: ProgressiveTranscriptOptions) {
		super();
		this.tailBudget = options.tailBudget;
		this.warmChunkSize = options.warmChunkSize;
		this.requestRender = options.requestRender;
	}

	/** True when every child has been rendered at least once and no work is pending. */
	get isFullyHydrated(): boolean {
		return this.visibleFrom === 0 && !this.hydrationScheduled;
	}

	override render(width: number): string[] {
		this.lastRenderWidth = width;
		const total = this.children.length;
		if (this.visibleFrom === 0 || total === 0) {
			this.visibleFrom = 0;
			this.warmedFrom = 0;
			return super.render(width);
		}

		const firstVisible = Math.max(0, total - this.tailBudget);
		if (firstVisible === 0) {
			// Whole transcript fits the visible budget: nothing is worth deferring.
			this.visibleFrom = 0;
			this.warmedFrom = 0;
			return super.render(width);
		}

		if (this.visibleFrom === PENDING_FIRST_PAINT) {
			this.visibleFrom = firstVisible;
			this.warmedFrom = firstVisible;
		}
		this.scheduleHydration();
		return this.renderRange(this.visibleFrom, total, width);
	}

	// `addChild` is inherited: a live message appended before hydration finishes
	// sits past the watermark, so it paints on the very next frame.

	override clear(): void {
		this.cancelHydration();
		this.visibleFrom = PENDING_FIRST_PAINT;
		this.warmedFrom = PENDING_FIRST_PAINT;
		super.clear();
	}

	override detachAll(): void {
		this.cancelHydration();
		this.visibleFrom = PENDING_FIRST_PAINT;
		this.warmedFrom = PENDING_FIRST_PAINT;
		super.detachAll();
	}

	override dispose(): void {
		this.hydrationHalted = true;
		this.cancelHydration();
		super.dispose();
	}

	// `invalidate` is inherited: `Container.invalidate` already walks every child,
	// so a theme switch reaches the un-warmed head and it cannot warm with a stale palette.

	private renderRange(from: number, to: number, width: number): string[] {
		const lines: string[] = [];
		for (let index = from; index < to; index++) {
			const child = this.children[index];
			if (child === undefined) continue;
			let childLines: string[];
			try {
				childLines = child.render(width);
			} catch {
				const componentName = child.constructor.name || "AnonymousComponent";
				childLines = [`[render error: ${componentName}]`];
			}
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}

	private scheduleHydration(): void {
		if (this.hydrationScheduled || this.hydrationHalted) return;
		this.hydrationScheduled = true;
		const generation = this.hydrationGeneration;
		setImmediate(() => {
			this.hydrationScheduled = false;
			this.warmNextChunk(generation);
		});
	}

	/**
	 * Warm one bounded chunk of the deferred head. Each child is actually rendered
	 * here so its own line cache is populated off the critical path; the eventual
	 * full-history frame then pays for cache hits instead of one burst of Markdown
	 * work. Without this the deferred cost would merely be moved, not spread.
	 */
	private warmNextChunk(generation: number): void {
		if (this.hydrationHalted || generation !== this.hydrationGeneration) return;
		if (this.warmedFrom === 0) return;

		const chunkEnd = this.warmedFrom;
		const chunkStart = Math.max(0, chunkEnd - this.warmChunkSize);
		const width = this.lastRenderWidth;
		if (width !== undefined) {
			// Discard the lines: this pass exists only to fill each child's cache.
			this.renderRange(chunkStart, chunkEnd, width);
		}
		this.warmedFrom = chunkStart;

		if (chunkStart === 0) {
			// The whole transcript is renderable now; publish it in one repaint.
			this.visibleFrom = 0;
			this.requestRender();
			return;
		}
		this.scheduleHydration();
	}

	private cancelHydration(): void {
		// Bumping the generation makes any already-queued macrotask a no-op, so a
		// clear + rebuild cannot warm components that no longer belong to the tree.
		this.hydrationGeneration += 1;
		this.hydrationScheduled = false;
	}
}
