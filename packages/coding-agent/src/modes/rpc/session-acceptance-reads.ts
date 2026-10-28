import { CompactLaneCurrent } from "./compact-lane-current.ts";
import type { CutStorageUse } from "./compact-session-state.ts";
import type { CompactSettledMessages } from "./compact-settled-messages.ts";
import type { FrozenAcceptedRoot } from "./session-acceptance-lane.ts";

/**
 * The read side of an acceptance lane: every reader of a root goes through here and is refused once the root is not
 * live. Publishing and releasing roots stays with the lane (`SessionAcceptanceLane`), which owns these three fields.
 */
export class AcceptedRootReads {
	protected readonly live = new Set<FrozenAcceptedRoot>();
	protected readonly rootOwners = new WeakMap<FrozenAcceptedRoot, CompactSettledMessages>();
	protected readonly current = new CompactLaneCurrent();

	get liveRoots(): number {
		return this.live.size;
	}

	/** True while `root` is readable: published by this lane and not released, by its holder or a retirement. */
	holds(root: FrozenAcceptedRoot): boolean {
		return this.live.has(root);
	}

	readCurrent(root: FrozenAcceptedRoot) {
		if (!this.live.has(root)) throw new Error("accepted root released");
		return this.current.read(root.current);
	}

	readCurrentComponents(root: FrozenAcceptedRoot) {
		if (!this.live.has(root)) throw new Error("accepted root released");
		return this.current.readComponents(root.current);
	}

	readCurrentActive(root: FrozenAcceptedRoot) {
		if (!this.live.has(root)) throw new Error("accepted root released");
		return this.current.readActive(root.current);
	}

	readCurrentCalls(root: FrozenAcceptedRoot) {
		if (!this.live.has(root)) throw new Error("accepted root released");
		return this.current.readCalls(root.current);
	}

	/** The cut's content store under its lease (S09 catalog build and reads). */
	cutStorage<T>(root: FrozenAcceptedRoot, use: CutStorageUse<T>): Promise<T> {
		return this.current.cutStorage(root.current, use);
	}

	readSettled(root: FrozenAcceptedRoot) {
		return this.settledOwner(root).read(root.settled);
	}

	/** The bounded settled reader of a live root (S10b catalog families); refused once the root is released. */
	settledOf(root: FrozenAcceptedRoot) {
		return this.settledOwner(root).reader(root.settled);
	}

	private settledOwner(root: FrozenAcceptedRoot): CompactSettledMessages {
		const owner = this.rootOwners.get(root);
		if (!owner || !this.live.has(root)) throw new Error("accepted root released");
		return owner;
	}
}
