import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import type { CheckpointToken } from "./compact-recovery-types.ts";

/** A frozen cut and the lease operations used by baseline/recovery consumers. */
export interface FrozenCheckpoint {
	readonly token: CheckpointToken;
	readonly lane: SessionAcceptanceLane;
	readonly root: FrozenAcceptedRoot;
	hold<T>(read: () => Promise<T>): Promise<T>;
	retain(): RetainedRoot;
}

/** A retained consumer outlives token retirement until its own end receipt. */
export interface RetainedRoot {
	readonly lane: SessionAcceptanceLane;
	readonly root: FrozenAcceptedRoot;
	hold<T>(read: () => Promise<T>): Promise<T>;
	end(): void;
}
