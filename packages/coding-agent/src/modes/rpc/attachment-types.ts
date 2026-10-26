/** Live-only, identity-fenced attachment commands owned by the multi-session host. */
export type RpcAttachmentCommand =
	| {
			readonly id?: string;
			readonly type: "attach_session";
			readonly sessionId: string;
			readonly durableSessionId: string;
			readonly expectedHostInstance?: string;
	  }
	| { readonly id?: string; readonly type: "release_attachment"; readonly sessionId: string }
	| {
			readonly id?: string;
			readonly type: "reclaim_session";
			readonly sessionPath: string;
			readonly durableSessionId: string;
			readonly expectedHostInstance: string;
	  };

export type RpcAttachmentResponse =
	| {
			readonly id?: string;
			readonly type: "response";
			readonly command: "attach_session";
			readonly success: true;
			readonly data: { readonly sessionId: string; readonly attached: true };
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
