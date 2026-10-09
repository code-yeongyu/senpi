import {
	type Component,
	Container,
	claimFrameRow,
	currentRenderRevision,
	dispatchMouseEvent,
	frameMode,
	frameScrollbackRows,
	getCapabilities,
	joinLineArrays,
	mainScreenHistoryLines,
	renderAtFrameRow,
	Spacer,
	type TerminalCapabilities,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";

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
	/** Line shown above the kept history on the main screen; `hidden` counts the earlier messages left out. */
	readonly historyMarker?: (hidden: number) => string;
};

/** The main-screen marker above kept history, unstyled. */
export function defaultHistoryMarker(hidden: number): string {
	return `${hidden.toLocaleString("en-US")} earlier ${hidden === 1 ? "message" : "messages"} · /tree to browse, or switch to fullscreen`;
}

/** A kept window may grow to this multiple of its budget before its top moves; each move replays it once. */
const HISTORY_SLACK = 1.5;

/** Trailing children painted on the first frame; roughly two tall viewports of messages. */
export const DEFAULT_TAIL_BUDGET = 60 as const;

/** Earlier children warmed per macrotask during background hydration. */
export const DEFAULT_WARM_CHUNK_SIZE = 100 as const;

/** Watermark sentinel: no frame has been painted yet, so nothing is proven renderable. */
const PENDING_FIRST_PAINT = -1 as const;

/** What a cached child render was produced under; any difference makes it stale. */
type RenderKey = {
	readonly width: number;
	readonly capabilities: TerminalCapabilities;
	readonly generation: number;
};

type CachedChildRender = RenderKey & { readonly revision: number; readonly lines: readonly string[] };

/**
 * The leading run of revisioned children painted last frame. While every one of them is the same
 * object at the same revision, their joined lines are reused as-is and none of them is rendered.
 */
type StablePrefix = RenderKey & {
	readonly from: number;
	/** Render revision clock when the prefix was checked; unchanged means no revisioned child changed. */
	readonly clock: number;
	readonly children: readonly Component[];
	readonly revisions: readonly number[];
	readonly heights: readonly number[];
	readonly lines: readonly string[];
};

type PaintedLayout = { readonly width: number; readonly children: readonly Component[]; readonly heights: number[] };

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
	 * Index of the first child published to the TUI. It stays at the first
	 * frame's tail boundary until the deferred head is fully warmed, then drops
	 * to zero in one atomic completion repaint.
	 */
	private visibleFrom: number = PENDING_FIRST_PAINT;
	/** Index of the first child whose render cache is warmed. */
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

	private readonly childRenders = new WeakMap<Component, CachedChildRender>();
	/** Last painted output and frame row of each live child, for rows already in native scrollback. */
	private readonly scrolledLiveRows = new WeakMap<
		Component,
		RenderKey & { readonly row: number; readonly lines: readonly string[] }
	>();
	/** Bumped by `invalidate()` (theme change): every cached render from before is stale. */
	private generation = 0;
	private stablePrefix: StablePrefix | undefined;
	private paintedLayout: PaintedLayout | undefined;
	private readonly historyMarker: (hidden: number) => string;
	/**
	 * First child kept on the main screen. Earlier children stay mounted (and in the session file,
	 * `/tree` and fullscreen) but are not written to the terminal, so resume and full repaints cost
	 * O(kept history) instead of O(session). Moves forward only in steps, see `HISTORY_SLACK`.
	 */
	private historyStart = 0;
	/** Non-spacer children before `start`; `anchor` is the child just before `start` when counted. */
	private hiddenMessages:
		| { readonly start: number; readonly anchor: Component | undefined; readonly count: number }
		| undefined;
	/** Children below this index are not warmed: the main screen will never paint them. */
	private hydrationFloor = 0;
	private readonly childHeights = new WeakMap<
		Component,
		RenderKey & { readonly height: number; readonly revision: number | undefined }
	>();

	constructor(options: ProgressiveTranscriptOptions) {
		super();
		this.tailBudget = options.tailBudget;
		this.warmChunkSize = options.warmChunkSize;
		this.requestRender = options.requestRender;
		this.historyMarker = options.historyMarker ?? defaultHistoryMarker;
	}

	/** True when every child has been rendered at least once and no work is pending. */
	get isFullyHydrated(): boolean {
		return (
			this.warmedFrom !== PENDING_FIRST_PAINT && this.warmedFrom <= this.hydrationFloor && !this.hydrationScheduled
		);
	}

	override render(width: number): string[] {
		this.lastRenderWidth = width;
		const frameRow = claimFrameRow(this);
		const total = this.children.length;
		// Children replaced by fewer in place (without clear/detachAll) must not leave the watermarks past the end.
		if (this.visibleFrom > total) this.visibleFrom = total;
		if (this.warmedFrom > total) this.warmedFrom = total;
		const key: RenderKey = { width, capabilities: getCapabilities(), generation: this.generation };
		const floor = frameMode() === "regular" ? this.keptHistoryStart(key) : 0;
		if (floor === 0) this.historyStart = 0;
		this.hydrationFloor = floor;
		if (this.visibleFrom !== PENDING_FIRST_PAINT && this.visibleFrom > floor && total > 0) {
			// The window widened (e.g. switching to fullscreen): warm the newly needed head in the
			// background like a resume, and keep painting the already-shown range until it is ready.
			this.scheduleHydration();
			return this.paint(this.visibleFrom, total, width, frameRow);
		}
		if ((this.visibleFrom !== PENDING_FIRST_PAINT && this.visibleFrom <= floor) || total === 0) {
			this.visibleFrom = floor;
			this.warmedFrom = Math.min(Math.max(this.warmedFrom, 0), floor);
			return this.paint(floor, total, width, frameRow);
		}

		const firstVisible = Math.max(floor, total - this.tailBudget);
		if (firstVisible === floor) {
			// Everything that will be shown fits the visible budget: nothing is worth deferring.
			this.visibleFrom = floor;
			this.warmedFrom = floor;
			return this.paint(floor, total, width, frameRow);
		}

		if (this.visibleFrom === PENDING_FIRST_PAINT) {
			this.visibleFrom = firstVisible;
			this.warmedFrom = firstVisible;
		}
		this.scheduleHydration();
		return this.paint(this.visibleFrom, total, width, frameRow);
	}

	/** Children `[from, total)`, preceded by the marker line when earlier history is left out. */
	private paint(from: number, total: number, width: number, frameRow: number | undefined): string[] {
		if (from === 0 || from !== this.historyStart || this.historyStart === 0) {
			return this.renderRange(from, total, width, true, frameRow);
		}
		const marker = this.historyMarker(this.hiddenMessageCount(from));
		const lines = this.renderRange(from, total, width, true, frameRow === undefined ? undefined : frameRow + 1);
		if (this.paintedLayout) {
			this.paintedLayout = {
				width,
				children: [HISTORY_MARKER_SLOT, ...this.paintedLayout.children],
				heights: [1, ...this.paintedLayout.heights],
			};
		}
		return [marker, ...lines];
	}

	/**
	 * Appends below the window never change the hidden count, and a window move only adds the
	 * children it passed, so this stays O(moved children) unless earlier children were replaced.
	 */
	private hiddenMessageCount(start: number): number {
		const cached = this.hiddenMessages;
		const intact = cached !== undefined && cached.start <= start && this.children[cached.start - 1] === cached.anchor;
		let count = intact ? cached.count : 0;
		for (let index = intact ? cached.start : 0; index < start; index++) {
			if (!(this.children[index] instanceof Spacer)) count++;
		}
		this.hiddenMessages = { start, anchor: this.children[start - 1], count };
		return count;
	}

	/**
	 * Index of the first child kept on the main screen. The kept window holds at least the history
	 * budget of lines and may grow to `HISTORY_SLACK` times it before its top jumps forward, so
	 * ordinary appends never change rows above the screen.
	 */
	private keptHistoryStart(key: RenderKey): number {
		const total = this.children.length;
		const budget = mainScreenHistoryLines();
		let start = Math.min(this.historyStart, total);
		let lines = 0;
		let index = total;
		while (index > start && lines <= budget * HISTORY_SLACK) {
			index--;
			lines += this.heightOf(this.children[index]!, key);
		}
		if (lines > budget * HISTORY_SLACK) {
			lines = 0;
			index = total;
			while (index > 0 && lines < budget) {
				index--;
				lines += this.heightOf(this.children[index]!, key);
			}
			start = index;
		}
		if (start > this.historyStart) this.releaseRenders(this.historyStart, start);
		this.historyStart = start;
		return start;
	}

	/**
	 * Children that moved above the kept window are never painted on the main screen again; their
	 * cached lines (here and inside the component) would otherwise grow with every message of a long
	 * run. Fullscreen and a width or theme change render them again on demand.
	 */
	private releaseRenders(from: number, to: number): void {
		for (let index = from; index < to; index++) {
			const child = this.children[index];
			if (child === undefined) continue;
			this.childRenders.delete(child);
			this.childHeights.delete(child);
			this.scrolledLiveRows.delete(child);
			child.invalidate();
		}
		// Released rows are cold again: fullscreen warms them in the background before showing them.
		if (this.warmedFrom !== PENDING_FIRST_PAINT && this.warmedFrom < to) this.warmedFrom = to;
		this.stablePrefix = undefined;
	}

	private heightOf(child: Component, key: RenderKey): number {
		const known = this.childHeights.get(child);
		if (
			known !== undefined &&
			known.width === key.width &&
			known.capabilities === key.capabilities &&
			known.generation === key.generation &&
			(known.revision === undefined || known.revision === child.getRenderRevision?.())
		) {
			return known.height;
		}
		return this.renderChild(child, key, undefined, 0).lines.length;
	}

	/** Drop every cached child render, e.g. after a theme change reached children outside this container. */
	invalidateCache(): void {
		this.generation += 1;
		this.stablePrefix = undefined;
		this.paintedLayout = undefined;
	}

	override invalidate(): void {
		this.invalidateCache();
		super.invalidate();
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const layout = this.paintedLayout;
		// A click laid out for another width than the last paint cannot be mapped to what is on screen.
		if (layout?.width !== event.width) return undefined;
		if (event.y < 0 || event.y >= event.height) return undefined;
		let childY = 0;
		for (let index = 0; index < layout.children.length; index++) {
			const child = layout.children[index]!;
			const height = layout.heights[index] ?? 0;
			if (event.y >= childY && event.y < childY + height) {
				return dispatchMouseEvent(child, { ...event, y: event.y - childY, height });
			}
			childY += height;
		}
		return undefined;
	}

	// `addChild` is inherited: a live message appended before hydration finishes
	// sits past the watermark, so it paints on the very next frame.

	override clear(): void {
		this.cancelHydration();
		this.rearmHydration();
		this.stablePrefix = undefined;
		this.paintedLayout = undefined;
		this.historyStart = 0;
		this.hiddenMessages = undefined;
		super.clear();
	}

	override detachAll(): void {
		this.cancelHydration();
		this.rearmHydration();
		this.stablePrefix = undefined;
		this.paintedLayout = undefined;
		this.historyStart = 0;
		this.hiddenMessages = undefined;
		super.detachAll();
	}

	/**
	 * Reuse re-arms hydration. `clear()` and `detachAll()` declare that this
	 * container is being repopulated with new content, so the watermark AND the
	 * teardown halt both have to return to their pre-first-paint state. Resetting
	 * only the watermark left a disposed-then-reused container silently inert: it
	 * painted its bounded tail forever and never warmed the deferred head, because
	 * `scheduleHydration()` and `warmNextChunk()` both early-return on the halt.
	 *
	 * Deliberately not folded into `cancelHydration()`: `dispose()` calls that
	 * immediately after setting the halt, so re-arming there would undo teardown.
	 */
	private rearmHydration(): void {
		this.visibleFrom = PENDING_FIRST_PAINT;
		this.warmedFrom = PENDING_FIRST_PAINT;
		this.hydrationHalted = false;
	}

	override dispose(): void {
		this.hydrationHalted = true;
		this.cancelHydration();
		super.dispose();
	}

	// `invalidate` is inherited: `Container.invalidate` already walks every child,
	// so a theme switch reaches the un-warmed head and it cannot warm with a stale palette.

	/**
	 * Render children `[from, to)`. A child that reports a render revision is rendered once per
	 * (width, capabilities, theme generation, revision) and its lines are reused afterwards; the
	 * leading run of such children is reused as one joined block while it is unchanged. Children
	 * without a revision (streaming, animating, unknown) render every frame exactly as before.
	 */
	private renderRange(
		from: number,
		to: number,
		width: number,
		painted = false,
		frameRow: number | undefined = undefined,
	): string[] {
		const key: RenderKey = { width, capabilities: getCapabilities(), generation: this.generation };
		const scrollbackRows = frameRow === undefined ? 0 : frameScrollbackRows();
		const reused = painted ? this.reusablePrefix(from, to, key) : undefined;
		const prefixChildren: Component[] = reused ? [...reused.children] : [];
		const prefixRevisions: number[] = reused ? [...reused.revisions] : [];
		const prefixHeights: number[] = reused ? [...reused.heights] : [];
		const prefixChunks: (readonly string[])[] = reused ? [reused.lines] : [];
		const tailChunks: (readonly string[])[] = [];
		const tailChildren: Component[] = [];
		const tailHeights: number[] = [];
		let prefixOpen = true;
		let row = frameRow === undefined ? undefined : frameRow + (reused?.lines.length ?? 0);
		for (let index = from + prefixChildren.length; index < to; index++) {
			const child = this.children[index];
			if (child === undefined) continue;
			const { lines, revision } = this.renderChild(child, key, row, scrollbackRows);
			this.childHeights.set(child, { ...key, height: lines.length, revision });
			if (row !== undefined) row += lines.length;
			if (prefixOpen && revision !== undefined) {
				prefixChildren.push(child);
				prefixRevisions.push(revision);
				prefixHeights.push(lines.length);
				prefixChunks.push(lines);
				continue;
			}
			prefixOpen = false;
			tailChildren.push(child);
			tailHeights.push(lines.length);
			tailChunks.push(lines);
		}
		if (!painted) return joinLineArrays([...prefixChunks, ...tailChunks]);

		const prefixLines = prefixChunks.length === 1 ? prefixChunks[0]! : joinLineArrays(prefixChunks);
		this.stablePrefix = {
			...key,
			clock: currentRenderRevision(),
			from,
			children: prefixChildren,
			revisions: prefixRevisions,
			heights: prefixHeights,
			lines: prefixLines,
		};
		this.paintedLayout = {
			width,
			children: [...prefixChildren, ...tailChildren],
			heights: [...prefixHeights, ...tailHeights],
		};
		return joinLineArrays([prefixLines, ...tailChunks]);
	}

	/**
	 * The longest leading part of last frame's stable prefix whose children are still the same objects
	 * at the same revisions. While the render revision clock has not moved no revisioned component
	 * changed, so only identities are compared.
	 */
	private reusablePrefix(from: number, to: number, key: RenderKey): StablePrefix | undefined {
		const prefix = this.stablePrefix;
		if (
			prefix === undefined ||
			prefix.from !== from ||
			prefix.width !== key.width ||
			prefix.capabilities !== key.capabilities ||
			prefix.generation !== key.generation
		) {
			return undefined;
		}
		const clockUnchanged = prefix.clock === currentRenderRevision();
		const limit = Math.min(prefix.children.length, to - from);
		let kept = 0;
		while (kept < limit) {
			const child = this.children[from + kept];
			if (child !== prefix.children[kept]) break;
			if (!clockUnchanged && child.getRenderRevision?.() !== prefix.revisions[kept]) break;
			kept++;
		}
		if (kept === prefix.children.length) return prefix;
		if (kept === 0) return undefined;
		let keptLines = 0;
		for (let index = 0; index < kept; index++) keptLines += prefix.heights[index] ?? 0;
		return {
			...prefix,
			children: prefix.children.slice(0, kept),
			revisions: prefix.revisions.slice(0, kept),
			heights: prefix.heights.slice(0, kept),
			lines: prefix.lines.slice(0, keptLines),
		};
	}

	private renderChild(
		child: Component,
		key: RenderKey,
		row: number | undefined,
		scrollbackRows: number,
	): { lines: readonly string[]; revision: number | undefined } {
		const revision = child.getRenderRevision?.();
		const scrolled = revision === undefined && row !== undefined ? this.scrolledLiveRows.get(child) : undefined;
		if (
			scrolled !== undefined &&
			scrolled.row === row &&
			scrolled.width === key.width &&
			scrolled.capabilities === key.capabilities &&
			scrolled.generation === key.generation &&
			row + scrolled.lines.length <= scrollbackRows
		) {
			// Native scrollback cannot be repainted in place: changing a row there replays the whole
			// transcript. A live child that scrolled out entirely keeps the rows the terminal shows.
			return { lines: scrolled.lines, revision: undefined };
		}
		if (revision !== undefined) {
			const cached = this.childRenders.get(child);
			if (
				cached !== undefined &&
				cached.revision === revision &&
				cached.width === key.width &&
				cached.capabilities === key.capabilities &&
				cached.generation === key.generation
			) {
				return { lines: cached.lines, revision };
			}
		}
		let lines: string[];
		try {
			lines = renderAtFrameRow(child, key.width, row);
		} catch {
			const componentName = child.constructor.name || "AnonymousComponent";
			return { lines: [`[render error: ${componentName}]`], revision: undefined };
		}
		// Read the revision again: a component may settle lazily inside render (ThemedText rebuilds there).
		const settled = child.getRenderRevision?.();
		if (settled === undefined) {
			if (row !== undefined) this.scrolledLiveRows.set(child, { ...key, row, lines });
			return { lines, revision: undefined };
		}
		this.childRenders.set(child, { ...key, revision: settled, lines });
		return { lines, revision: settled };
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
		if (this.warmedFrom <= this.hydrationFloor) {
			// Nothing below the window is cold: show the warmed range if the last frame still hid it.
			if (this.visibleFrom > this.hydrationFloor) {
				this.visibleFrom = this.hydrationFloor;
				this.requestRender();
			}
			return;
		}

		const chunkEnd = this.warmedFrom;
		const floor = Math.min(this.hydrationFloor, chunkEnd);
		const chunkStart = Math.max(floor, chunkEnd - this.warmChunkSize);
		const width = this.lastRenderWidth;
		if (width !== undefined) {
			// Discard the lines: this pass exists only to fill each child's cache.
			this.renderRange(chunkStart, chunkEnd, width);
		}
		this.warmedFrom = chunkStart;

		if (chunkStart === floor) {
			// Publish the fully warmed history in one atomic height increase.
			this.visibleFrom = floor;
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

/** Placeholder for the marker row in the painted mouse layout; it handles no events. */
const HISTORY_MARKER_SLOT: Component = { render: () => [], invalidate: () => {} };
