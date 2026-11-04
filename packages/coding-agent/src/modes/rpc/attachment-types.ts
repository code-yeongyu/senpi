/** Live-only, identity-fenced attachment commands owned by the multi-session host. */
export type RpcAttachmentCommand =
	| {
			readonly id?: string;
			readonly type: "attach_session";
			readonly admissionId?: string;
			/** A C4.4 resend of `admissionId` (RULING-125, docs/rpc.md "Admission retries"); ignored with the flag off. */
			readonly retry?: true;
			readonly sessionId: string;
			readonly durableSessionId: string;
			readonly expectedHostInstance?: string;
			/** A headless engine with a takeover ledger only: take the session over for `holder` (R21; S37). */
			readonly takeover?: true;
			/** The taking client's stable identity, kept across its reconnects; required with `takeover`. */
			readonly holder?: string;
	  }
	| { readonly id?: string; readonly type: "release_attachment"; readonly sessionId: string }
	| {
			readonly id?: string;
			readonly type: "reclaim_session";
			readonly sessionPath: string;
			readonly durableSessionId: string;
			readonly expectedHostInstance: string;
	  };

/** Sent to each connection a takeover let go: it no longer holds the session, which goes on running. */
export interface RpcSessionReleasedRecord {
	readonly type: "session_released";
	readonly sessionId: string;
	readonly reason: "taken_over";
}

export type RpcAttachmentResponse =
	| {
			readonly id?: string;
			readonly type: "response";
			readonly command: "attach_session";
			readonly success: true;
			readonly data: {
				readonly sessionId: string;
				readonly attached: true;
				/** On a takeover: the holder now, its generation, and how many other connections were let go. */
				readonly holder?: string;
				readonly generation?: number;
				readonly released?: number;
			};
	  }
	| {
			readonly id?: string;
			readonly type: "response";
			readonly command: "release_attachment";
			readonly success: true;
			readonly data: { readonly deferred: boolean };
	  }
	| {
			readonly id?: string;
			readonly type: "response";
			readonly command: "reclaim_session";
			readonly success: true;
			readonly data: { readonly reclaimed: true; readonly sessionId: string };
	  };
