/** Answers to a user Stop's pause and its resume: held human input, run holds, and resume_session (senpi#3811). */
export type RpcPauseResponse =
	| {
			id?: string;
			type: "response";
			command: "hold_input";
			success: true;
			data: { entryId?: string; duplicate?: boolean; alreadyDelivered?: boolean };
	  }
	| { id?: string; type: "response"; command: "withdraw_held_input"; success: true; data: { withdrawn: boolean } }
	| { id?: string; type: "response"; command: "pause_for_run"; success: true; data: { held: true; childSeq: number } }
	| {
			id?: string;
			type: "response";
			command: "resume_for_run";
			success: true;
			data: { released: boolean; reason?: "stale" | "not_held"; otherHoldLive?: boolean; turnId?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "resume_session";
			success: true;
			data?: {
				resumed: boolean;
				reason?: "stale" | "not_paused" | "resume_through_parent";
				parentSessionId?: string;
				pauseSeq: number;
				turnStarted: boolean;
				deliveredNotices: number;
				deliveredHeldInputs: number;
				replayed?: boolean;
			};
	  };
