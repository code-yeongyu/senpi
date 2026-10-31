/**
 * A legacy view frozen at one cut and read one frame at a time by a peer's baseline barrier (R3.C6.4). The
 * reader retains no array of generated frames; `release` ends the read on every path and is idempotent.
 */
export interface LegacyViewCursor {
	/** True when the frozen view has no frame at all: an attach installs no barrier and releases it at once. */
	readonly empty: boolean;
	next(): Promise<string | undefined>;
	release(): void;
}

/** The frames of one view: how many, and each one derived on demand from the frozen source. */
export type FrozenFrames = { readonly count: number; readonly frame: (index: number) => string };

/**
 * A cursor over frames the owner releases once. `source` runs on the first read (`next` or `empty`): an owner that
 * fixes the view at the freeze passes the frames it already built, one that fixes it at the read passes a thunk.
 */
export class FrozenFramesCursor implements LegacyViewCursor {
	private index = 0;
	private released = false;
	private frames: FrozenFrames | undefined;
	private readonly source: () => FrozenFrames;
	private readonly onRelease: () => void;

	constructor(source: () => FrozenFrames, onRelease: () => void) {
		this.source = source;
		this.onRelease = onRelease;
	}

	get empty(): boolean {
		return this.read().count === 0;
	}

	async next(): Promise<string | undefined> {
		if (this.released) return undefined;
		const frames = this.read();
		if (this.index >= frames.count) return undefined;
		return frames.frame(this.index++);
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.onRelease();
	}

	private read(): FrozenFrames {
		this.frames ??= this.source();
		return this.frames;
	}
}

/**
 * A cursor whose frames are produced one at a time by an async generator over a frozen source (the compact
 * current-state view). `empty` is decided synchronously by the owner from the frozen roots, so an attach with
 * nothing to deliver installs no barrier; the generator starts on the first read.
 */
export class GeneratedFramesCursor implements LegacyViewCursor {
	readonly empty: boolean;
	private frames: AsyncGenerator<string> | undefined;
	private released = false;
	private readonly source: () => AsyncGenerator<string>;
	private readonly onRelease: () => void;

	constructor(empty: boolean, source: () => AsyncGenerator<string>, onRelease: () => void) {
		this.empty = empty;
		this.source = source;
		this.onRelease = onRelease;
	}

	async next(): Promise<string | undefined> {
		if (this.released) return undefined;
		this.frames ??= this.source();
		const step = await this.frames.next();
		return step.done ? undefined : step.value;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		void this.frames?.return(undefined);
		this.onRelease();
	}
}
