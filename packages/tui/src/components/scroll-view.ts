import {
	LAYOUT_NODE,
	type ScrollEntryAnchor,
	type ScrollEntryFrame,
	type ScrollEntryPlacement,
	type ScrollEntryRender,
	type ScrollEntrySource,
	type ScrollLayoutNode,
} from "../layout-node.ts";
import {
	type Component,
	Container,
	renderComponentError,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";

export type ScrollViewScrollbar = "hidden" | "auto" | "always";

export interface ScrollViewOptions {
	entries?: ScrollEntrySource;
	axis?: "vertical";
	follow?: "none" | "end";
	primary?: boolean;
	overscroll?: "chain" | "contain";
	scrollbar?: ScrollViewScrollbar;
	scrollbarTrackStyle?: (text: string) => string;
	scrollbarThumbStyle?: (text: string) => string;
	scrollbarHideDelayMs?: number;
}

export interface ScrollViewScrollToOptions {
	/** Keep follow-end disabled even when the target is the current content end. */
	disableFollow?: boolean;
}

const ENTRY_LIMIT = 64;
const ENTRY_BYTES = 8 * 1024 * 1024;
const ENTRY_BUDGET_MS = 8;
type EntryPlacement = Omit<ScrollEntryPlacement, "top"> & { top: number };
interface EntryWindow {
	entries: EntryPlacement[];
	atStart: boolean;
	atEnd: boolean;
}
type EntryWalk = Generator<number, EntryWindow, ScrollEntryRender>;
interface EntryCache extends ScrollEntryRender {
	displayRevision: number;
	epoch: number;
	bytes: number;
}
interface EntryJob {
	following: boolean;
	lastSourceIndex: number;
	emptyEntries: Set<number> | undefined;
	width: number;
	height: number;
	version: number;
	displayRevision: number;
	walk: EntryWalk;
	step: IteratorResult<number, EntryWindow>;
}

export class ScrollView extends Container {
	readonly entrySource: ScrollEntrySource | undefined;
	private readonly entryCache = new Map<object, EntryCache>();
	private entryCacheBytes = 0;
	private entryWidth = 0;
	private entryEpoch = 0;
	private inEntryFrame = false;
	private entryAnchor: ScrollEntryAnchor | undefined;
	private entryDelta = 0;
	private entryTarget: number | undefined;
	private entryJob: EntryJob | undefined;
	private entryFrame: ScrollEntryFrame | undefined;
	private entryExtent = 1;
	private entryPosition = 0;
	private entryDisposed = false;
	private entryAtStart = true;
	private entryAtEnd = true;
	private observedEmptyEntries: readonly number[] | undefined = [];
	private cacheSourceVersion = -1;
	private readonly child: Component;
	readonly followEnd: boolean;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarTrackStyle: (text: string) => string;
	readonly scrollbarThumbStyle: (text: string) => string;
	private currentScrollbar: ScrollViewScrollbar;
	private readonly scrollbarHideDelayMs: number;
	private currentScrollTop = 0;
	private contentHeight = 0;
	private currentViewportHeight = 0;
	private followingEnd: boolean;
	private followSuppressedAtEnd = false;
	private requestRenderCallback: (() => void) | undefined;
	private transientScrollbarVisible = false;
	private scrollbarActive = false;
	private scrollbarHideTimer: NodeJS.Timeout | undefined;

	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical") {
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		}
		if (options.entries && options.overscroll === "chain") {
			throw new Error("Entry-backed ScrollView requires overscroll: contain");
		}
		this.entrySource = options.entries;
		this.child = component;
		this.children.push(component);
		this.followEnd = (options.follow ?? "none") === "end";
		this.followingEnd = this.followEnd;
		this.primary = options.primary ?? false;
		this.overscroll = options.overscroll ?? (options.entries ? "contain" : "chain");
		this.currentScrollbar = options.scrollbar ?? "hidden";
		this.scrollbarTrackStyle = options.scrollbarTrackStyle ?? ((text) => `\x1b[90m${text}\x1b[39m`);
		this.scrollbarThumbStyle = options.scrollbarThumbStyle ?? ((text) => `\x1b[37m${text}\x1b[39m`);
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}

	/** Row offset for legacy content; entry index plus local row fraction for indexed content. */
	get scrollTop(): number {
		return this.currentScrollTop;
	}

	get isFollowingEnd(): boolean {
		return this.followingEnd;
	}

	get viewportHeight(): number {
		return this.currentViewportHeight;
	}

	get scrollbar(): ScrollViewScrollbar {
		return this.currentScrollbar;
	}

	get isScrollbarVisible(): boolean {
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		return this.scrollbar === "auto" && this.canScroll() && this.transientScrollbarVisible;
	}

	get isScrollbarActive(): boolean {
		return this.scrollbarActive;
	}

	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		if (scrollbar === this.currentScrollbar) return;
		this.currentScrollbar = scrollbar;
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		else if (this.scrollbarActive) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	getContentWidth(width: number): number {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	private canScroll(): boolean {
		return this.entrySource ? this.entryExtent < 1 : this.contentHeight > this.currentViewportHeight;
	}

	private markScrollbarActivity(): void {
		if (this.scrollbar !== "auto" || !this.canScroll()) return;
		this.transientScrollbarVisible = true;
		if (this.scrollbarHideTimer) {
			clearTimeout(this.scrollbarHideTimer);
			this.scrollbarHideTimer = undefined;
		}
		if (this.scrollbarActive) return;
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.transientScrollbarVisible = false;
			this.requestRenderCallback?.();
		}, this.scrollbarHideDelayMs);
		this.scrollbarHideTimer.unref();
	}

	private hideTransientScrollbar(): void {
		this.transientScrollbarVisible = false;
		if (!this.scrollbarHideTimer) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	setScrollbarActive(active: boolean): void {
		if (active === this.scrollbarActive) return;
		this.scrollbarActive = active;
		this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	/** Indexed callers should prefer scrollToAnchor; numeric indexed offsets use entry units, not rows. */
	scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		if (this.entrySource) {
			if (!Number.isFinite(scrollTop)) return;
			this.entryTarget = Math.max(0, Math.min(this.entrySource.length, scrollTop));
			this.entryDelta = 0;
			this.followingEnd = this.followEnd && !options.disableFollow && this.entryTarget === this.entrySource.length;
			this.followSuppressedAtEnd = options.disableFollow === true;
			this.cancelEntryJob();
			return;
		}
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		const nextFollowSuppressedAtEnd = options.disableFollow === true && next === maxScrollTop;
		const nextFollowingEnd = !nextFollowSuppressedAtEnd && this.followEnd && next === maxScrollTop;
		if (
			next === this.currentScrollTop &&
			nextFollowingEnd === this.followingEnd &&
			nextFollowSuppressedAtEnd === this.followSuppressedAtEnd
		) {
			return;
		}
		const moved = next !== this.currentScrollTop;
		this.currentScrollTop = next;
		this.followingEnd = nextFollowingEnd;
		this.followSuppressedAtEnd = nextFollowSuppressedAtEnd;
		if (moved) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (requested === 0) return 0;
		if (this.entrySource) {
			this.entryDelta += requested;
			this.followingEnd = false;
			this.followSuppressedAtEnd = false;
			this.cancelEntryJob();
			return 0; // Indexed views contain overscroll, including deferred traversal.
		}
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const start = this.followingEnd ? maxScrollTop : this.currentScrollTop;
		const next = Math.max(0, Math.min(maxScrollTop, start + requested));
		const moved = next - start;
		const wasFollowingEnd = this.followingEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd && next === maxScrollTop;
		this.followSuppressedAtEnd = false;
		if (moved !== 0) this.markScrollbarActivity();
		if (moved !== 0 || this.followingEnd !== wasFollowingEnd) this.requestRenderCallback?.();
		return requested - moved;
	}

	scrollToStart(): void {
		if (this.entrySource) {
			this.scrollTo(0, { disableFollow: true });
			return;
		}
		const changed =
			this.currentScrollTop !== 0 ||
			this.followingEnd !== (this.followEnd && this.contentHeight <= this.currentViewportHeight);
		this.currentScrollTop = 0;
		this.followingEnd = this.followEnd && this.contentHeight <= this.currentViewportHeight;
		this.followSuppressedAtEnd = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	scrollToEnd(): void {
		if (this.entrySource) {
			this.entryTarget = this.entrySource.length;
			this.entryDelta = 0;
			this.followingEnd = this.followEnd;
			this.followSuppressedAtEnd = false;
			this.cancelEntryJob();
			return;
		}
		const next = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const changed = this.currentScrollTop !== next || this.followingEnd !== this.followEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd;
		this.followSuppressedAtEnd = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		this.contentHeight = Math.max(0, Math.floor(contentHeight));
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		this.requestRenderCallback = requestRender;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		if (this.followingEnd) this.currentScrollTop = maxScrollTop;
		else this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
		if (this.currentScrollTop < maxScrollTop) this.followSuppressedAtEnd = false;
		if (this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressedAtEnd) {
			this.followingEnd = true;
		}
		if (this.contentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
	}

	/** Demand one entry for explicit copy/search work; callers yield between entries. */
	renderEntry(index: number, width: number): ScrollEntryRender {
		const source = this.entrySource;
		if (!source || !Number.isInteger(index) || index < 0 || index >= source.length) {
			throw new RangeError("Scroll entry index is out of range");
		}
		width = Math.max(1, Math.floor(width));
		if (this.entryWidth !== width) {
			this.entryCache.clear();
			this.entryCacheBytes = 0;
			this.entryWidth = width;
		}
		const entry = { ...source.get(index) };
		const displayRevision = source.displayRevision;
		const cached = this.entryCache.get(entry.key);
		if (
			cached &&
			cached.entry.component === entry.component &&
			cached.entry.revision === entry.revision &&
			cached.displayRevision === displayRevision &&
			(entry.revision !== undefined || (this.inEntryFrame && cached.epoch === this.entryEpoch))
		) {
			this.entryCache.delete(entry.key);
			this.entryCache.set(entry.key, cached);
			return { entry, index, lines: cached.lines };
		}
		if (cached) {
			this.entryCache.delete(entry.key);
			this.entryCacheBytes -= cached.bytes;
		}
		// Renderers may reuse and mutate their result array; committed frames own a snapshot.
		let lines: string[];
		try {
			lines = [...entry.component.render(width)];
		} catch (error) {
			if (!this.inEntryFrame) throw error;
			// Failed entries must be retried on the next frame, even with an explicit revision.
			return { entry, index, lines: renderComponentError(entry.component, error) };
		}
		// Charge UTF-16 payload plus conservative array slots; blank-heavy outputs also cost space.
		const bytes = lines.reduce((sum, line) => sum + line.length * 2 + 8, 32);
		const result = { entry, index, lines };
		if (bytes <= ENTRY_BYTES) {
			while (this.entryCache.size >= ENTRY_LIMIT || this.entryCacheBytes + bytes > ENTRY_BYTES) {
				const oldest = this.entryCache.keys().next().value;
				if (oldest === undefined) break;
				this.entryCacheBytes -= this.entryCache.get(oldest)!.bytes;
				this.entryCache.delete(oldest);
			}
			this.entryCache.set(entry.key, {
				...result,
				bytes,
				epoch: this.entryEpoch,
				displayRevision,
			});
			this.entryCacheBytes += bytes;
		}
		return result;
	}

	scrollToAnchor(anchor: ScrollEntryAnchor, options: ScrollViewScrollToOptions = {}): void {
		if (!this.entrySource) return;
		this.entryAnchor = { ...anchor, row: Math.max(0, Math.floor(anchor.row)) };
		this.entryTarget = undefined;
		this.entryDelta = 0;
		this.followingEnd = false;
		this.followSuppressedAtEnd = options.disableFollow === true;
		this.cancelEntryJob();
	}

	getEntryScrollbar(): { position: number; extent: number } | undefined {
		return this.entrySource ? { position: this.entryPosition, extent: this.entryExtent } : undefined;
	}

	scrollToEntryFraction(fraction: number): void {
		if (!this.entrySource || !Number.isFinite(fraction)) return;
		const clamped = Math.max(0, Math.min(1, fraction));
		if (clamped === 1) this.scrollToEnd();
		else this.scrollTo(clamped * this.entrySource.length * (1 - this.entryExtent), { disableFollow: true });
	}

	private cancelEntryJob(): void {
		this.entryJob = undefined;
		this.entryFrame = undefined;
		this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	private *walkEntries(height: number): EntryWalk {
		const source = this.entrySource!;
		if (source.length === 0 || height === 0) return { entries: [], atStart: true, atEnd: true };
		// ponytail: one admitted entry still renders as a whole; this bounds historical traversal,
		// not the cost of a single giant message. No second component range-rendering API.
		const tail = this.followingEnd || this.entryTarget === source.length;
		if (tail && this.entryDelta === 0) {
			const entries: EntryPlacement[] = [];
			let total = 0;
			let index = source.length - 1;
			for (; index >= 0; index--) {
				const entry = yield index;
				total += entry.lines.length;
				if (entry.lines.length > 0) entries.push({ ...entry, top: -total });
				if (total >= height) break;
			}
			const offset = Math.min(total, height);
			for (const entry of entries) entry.top += offset;
			entries.reverse();
			return { entries, atStart: index <= 0 && total <= height, atEnd: true };
		}
		let index = this.entryAnchor ? (source.resolve(this.entryAnchor.key, this.entryAnchor.sourceIndex) ?? 0) : 0;
		let row = this.entryAnchor?.row ?? 0;
		if (this.entryTarget !== undefined && !tail) index = Math.min(source.length - 1, Math.floor(this.entryTarget));
		let current: ScrollEntryRender;
		if (tail) {
			index = source.length - 1;
			current = yield index;
			row = current.lines.length;
		} else {
			index = Math.max(0, Math.min(source.length - 1, index));
			current = yield index;
			row =
				this.entryTarget !== undefined
					? Math.floor((this.entryTarget % 1) * current.lines.length)
					: Math.min(row, Math.max(0, current.lines.length - 1));
		}
		let delta = this.entryDelta - (tail ? height : 0);
		while (delta < 0) {
			if (-delta <= row) {
				row += delta;
				delta = 0;
				break;
			}
			delta += row;
			if (index === 0) {
				row = 0;
				break;
			}
			current = yield --index;
			row = current.lines.length;
		}
		while (delta > 0) {
			const available = Math.max(0, current.lines.length - row);
			if (delta < available) {
				row += delta;
				delta = 0;
				break;
			}
			if (index === source.length - 1) {
				row = current.lines.length;
				break;
			}
			delta -= available;
			current = yield ++index;
			row = 0;
		}
		const placements: EntryPlacement[] = [];
		const fillStartIndex = index;
		let atStart = index === 0 && row === 0;
		let top = -row;
		while (true) {
			if (current.lines.length > 0) placements.push({ ...current, top });
			top += current.lines.length;
			if (top >= height || index === source.length - 1) break;
			current = yield ++index;
		}
		const atEnd = index === source.length - 1 && top <= height;
		// Clamp near the end by filling upward rather than leaving an avoidable blank viewport.
		if (top < height && placements.length > 0 && !atStart) {
			let first = placements[0]!;
			let missing = height - top;
			const within = Math.min(missing, -first.top);
			if (within > 0) {
				for (const placement of placements) placement.top += within;
				missing -= within;
			}
			index = fillStartIndex - 1;
			while (missing > 0 && index >= 0) {
				current = yield index--;
				if (current.lines.length === 0) continue;
				const added = Math.min(missing, current.lines.length);
				for (const placement of placements) placement.top += added;
				first = { ...current, top: added - current.lines.length };
				placements.unshift(first);
				missing -= added;
			}
			if (index < 0 && placements[0]!.top === 0) atStart = true;
		}
		return { entries: placements, atStart, atEnd };
	}

	private *refreshEntries(frame: ScrollEntryFrame, height: number): EntryWalk {
		const refreshed: EntryPlacement[] = [];
		for (const index of this.observedEmptyEntries ?? []) {
			const empty = yield index;
			if (empty.lines.length !== 0) return yield* this.walkEntries(height);
		}
		for (const previous of frame.entries) {
			const current = yield previous.index;
			if (current.lines.length !== previous.lines.length) return yield* this.walkEntries(height);
			refreshed.push({ ...current, top: previous.top });
		}
		return { entries: refreshed, atStart: this.entryAtStart, atEnd: this.entryAtEnd };
	}

	renderEntryFrame(width: number, height: number, requestRender: () => void): ScrollEntryFrame {
		const source = this.entrySource!;
		if (this.entryDisposed) return this.emptyEntryFrame(width, height, false);
		this.requestRenderCallback = requestRender;
		this.currentViewportHeight = Math.max(0, Math.floor(height));
		height = this.currentViewportHeight;
		if (this.cacheSourceVersion !== source.version) {
			for (const [key, cached] of this.entryCache) {
				if (source.indexOf(key) === undefined) {
					this.entryCache.delete(key);
					this.entryCacheBytes -= cached.bytes;
				}
			}
			this.cacheSourceVersion = source.version;
		}
		this.entryEpoch++;
		this.inEntryFrame = true;
		try {
			let job = this.entryJob;
			// A tail append must not restart a pending walk through an unchanged browsed
			// prefix. The adapter's bounded journal proves which source indices are stable.
			if (
				job &&
				!job.following &&
				job.version !== source.version &&
				job.displayRevision === source.displayRevision &&
				!job.step.done &&
				job.step.value < source.length
			) {
				const changed = source.changedSince?.(job.version);
				if (changed !== undefined && changed > job.lastSourceIndex) job.version = source.version;
			}
			if (
				!job ||
				job.width !== width ||
				job.height !== height ||
				job.version !== source.version ||
				job.displayRevision !== source.displayRevision
			) {
				const committed = this.entryFrame;
				const reusable =
					this.entryTarget === undefined &&
					this.entryDelta === 0 &&
					committed &&
					this.observedEmptyEntries !== undefined &&
					committed.width === width &&
					committed.height === height &&
					committed.version === source.version &&
					committed.displayRevision === source.displayRevision;
				const walk = reusable ? this.refreshEntries(committed, height) : this.walkEntries(height);
				job = {
					following: this.followingEnd || this.entryTarget === source.length,
					lastSourceIndex: -1,
					emptyEntries: new Set(),
					width,
					height,
					version: source.version,
					displayRevision: source.displayRevision,
					walk,
					step: walk.next(),
				};
				this.entryJob = job;
			}
			const started = performance.now();
			let admitted = 0;
			const reads = new Map<number, ScrollEntryRender>();
			// Cooperative budget: a single component can exceed it, but never start a second
			// expensive entry after the budget is spent. Empty entries also have a count cap.
			while (
				!job.step.done &&
				admitted < ENTRY_LIMIT &&
				(admitted === 0 || performance.now() - started < ENTRY_BUDGET_MS)
			) {
				admitted++;
				const index = job.step.value;
				const rendered = reads.get(index) ?? this.renderEntry(index, width);
				reads.set(index, rendered);
				job.lastSourceIndex = Math.max(job.lastSourceIndex, rendered.entry.sourceIndex);
				if (rendered.lines.length === 0 && rendered.entry.revision === undefined && job.emptyEntries) {
					job.emptyEntries.add(index);
					// ponytail: arbitrary dynamic empties have no change notification. Observe at most
					// 64 near this window; larger runs use bounded re-traversal while keeping the old frame.
					if (job.emptyEntries.size > ENTRY_LIMIT) job.emptyEntries = undefined;
				}
				if (source.version !== job.version || source.displayRevision !== job.displayRevision) break;
				job.step = job.walk.next(rendered);
			}
			// A renderer can synchronously mutate the source. Never publish mixed generations.
			if (source.version !== job.version || source.displayRevision !== job.displayRevision) {
				this.entryJob = undefined;
				requestRender();
				return this.emptyEntryFrame(width, height, true);
			}
			if (!job.step.done) {
				requestRender();
				return this.emptyEntryFrame(width, height, true);
			}
			this.observedEmptyEntries = job.emptyEntries ? [...job.emptyEntries] : undefined;
			return this.commitEntryFrame(width, height, job.version, job.displayRevision, job.step.value);
		} finally {
			this.inEntryFrame = false;
		}
	}

	private commitEntryFrame(
		width: number,
		height: number,
		version: number,
		displayRevision: number,
		window: EntryWindow,
	): ScrollEntryFrame {
		const { entries, atStart, atEnd } = window;
		this.entryAtStart = atStart;
		this.entryAtEnd = atEnd;
		const source = this.entrySource!;
		const rows: ScrollEntryFrame["rows"][number][] = Array.from({ length: height });
		for (const placement of entries) {
			for (
				let row = Math.max(0, -placement.top);
				row < placement.lines.length && placement.top + row < height;
				row++
			) {
				rows[placement.top + row] = {
					anchor: { key: placement.entry.key, sourceIndex: placement.entry.sourceIndex, row },
					line: placement.lines[row]!,
					revision: placement.entry.revision,
				};
			}
		}
		this.entryJob = undefined;
		this.entryTarget = undefined;
		this.entryDelta = 0;
		this.entryAnchor = rows.find((row) => row !== undefined)?.anchor;
		const first = entries[0];
		const last = entries.at(-1);
		const start = !atStart && first ? first.index + Math.max(0, -first.top) / first.lines.length : 0;
		const end =
			!atEnd && last
				? last.index + Math.min(last.lines.length, height - last.top) / last.lines.length
				: source.length;
		this.currentScrollTop = start;
		this.entryExtent = source.length === 0 ? 1 : Math.min(1, Math.max(0, (end - start) / source.length));
		this.followingEnd = this.followEnd && atEnd && !this.followSuppressedAtEnd;
		const scrollable = source.length - (end - start);
		this.entryPosition = atEnd ? 1 : scrollable > 0 ? Math.min(1, start / scrollable) : 0;
		if (!this.canScroll()) this.hideTransientScrollbar();
		this.entryFrame = { source, width, height, version, displayRevision, pending: false, entries, rows };
		return this.entryFrame;
	}

	private emptyEntryFrame(width: number, height: number, pending: boolean): ScrollEntryFrame {
		if (this.entryFrame?.width === width && this.entryFrame.height === height) return { ...this.entryFrame, pending };
		return {
			source: this.entrySource!,
			width,
			height,
			version: this.entrySource!.version,
			displayRevision: this.entrySource!.displayRevision,
			pending,
			entries: [],
			rows: Array.from({ length: height }),
		};
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		// Indexed layout dispatches directly to the visible entry boxes. The owning
		// document must not be remeasured by Container's fallback mouse traversal.
		return this.entrySource ? undefined : super.handleMouse(event);
	}

	override dispose(): void {
		this.entryDisposed = true;
		this.entryJob = undefined;
		this.entryFrame = undefined;
		this.entryCache.clear();
		this.entryCacheBytes = 0;
		this.observedEmptyEntries = [];
		this.requestRenderCallback = undefined;
		this.hideTransientScrollbar();
		super.dispose();
	}

	override invalidate(): void {
		this.entryCache.clear();
		this.entryCacheBytes = 0;
		this.entryJob = undefined;
		this.entryFrame = undefined;
		super.invalidate();
	}

	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}

	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}

	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}

	override render(width: number): string[] {
		const contentWidth = this.getContentWidth(width);
		let lines: string[];
		if (this.entrySource) {
			// Explicit render is canonical output (exit/debug/export), not viewport admission.
			// Layout measures indexed subtrees separately and never takes this eager path.
			lines = [];
			for (let index = 0; index < this.entrySource.length; index++) {
				let entryLines: readonly string[];
				try {
					entryLines = this.renderEntry(index, contentWidth).lines;
				} catch (error) {
					entryLines = renderComponentError(this.entrySource.get(index).component, error);
				}
				for (const line of entryLines) lines.push(line);
			}
		} else lines = this.child.render(contentWidth);
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}

	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.child, state: this, entries: this.entrySource };
	}
}
