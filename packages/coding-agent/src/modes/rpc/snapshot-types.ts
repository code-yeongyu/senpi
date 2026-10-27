import type { SessionEntry } from "../../core/session-manager.ts";
import type { RpcExtensionUIRequest } from "./rpc-question-types.ts";
import type { RpcSessionState } from "./rpc-session-state-types.ts";

export type RpcSnapshot = {
	readonly state: RpcSessionState;
	readonly entries: SessionEntry[];
	readonly next_before: string | null;
	readonly history_truncated: boolean;
	readonly markerId: string;
};

export type RpcSnapshotMarker = {
	readonly type: "snapshot_marker";
	readonly sessionId: string;
	readonly markerId: string;
};

export type UiRequestChange =
	| {
			readonly type: "ui_request_pending";
			readonly uiRequestId: string;
			readonly method: RpcExtensionUIRequest["method"];
			readonly request: RpcExtensionUIRequest;
	  }
	| {
			readonly type: "ui_request_settled";
			readonly uiRequestId: string;
			readonly disposition: "answered" | "cancelled";
	  };

export type RpcUiRequestEvent = UiRequestChange & { readonly sessionId: string };
