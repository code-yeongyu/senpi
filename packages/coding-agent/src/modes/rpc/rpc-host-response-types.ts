import type { RpcUnloadAnswer } from "./rpc-effect-answer-types.ts";
import type { RpcSubscriptionLimitsEvent } from "./rpc-host-lifecycle-types.ts";
import type { RpcProtocolInfo } from "./rpc-protocol-info-types.ts";
import type { RpcSessionState } from "./rpc-session-state-types.ts";
import type { SessionStatusRecord } from "./session-status.ts";

export type RpcHostCommandResponse =
	| {
			id?: string;
			type: "response";
			command: "get_protocol_info";
			success: true;
			data: RpcProtocolInfo;
	  }
	| {
			id?: string;
			type: "response";
			command: "open_session";
			success: true;
			data: { sessionId: string; state: RpcSessionState; attached?: boolean };
	  }
	| { id?: string; type: "response"; command: "close_session"; success: true; data: Record<string, never> }
	| {
			id?: string;
			type: "response";
			command: "unload_session";
			success: true;
			/** A refusal changes nothing and names why (`reason`, `detail`) and what to do (`action`). */
			data: RpcUnloadAnswer;
	  }
	| {
			id?: string;
			type: "response";
			command: "release_session";
			success: true;
			/**
			 * `attachments`: clients that were still attached (non-zero only with `force`). `dropped`: what an
			 * `interrupt` took out of the queues - delivery ids their sender must redeliver to the next owner,
			 * and the user's queued steer/follow-up text in enqueue order, for the adopting client to handle.
			 */
			data: {
				released: true;
				session_path: string;
				attachments: number;
				dropped: { deliveries: readonly string[]; user_messages: readonly string[] };
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "warm";
			success: true;
			/** `unsupported`: this host's session runtime cannot be warmed from the host process (worker isolates). */
			data: { state: "warmed" | "already_warm" | "unsupported" };
	  }
	| {
			id?: string;
			type: "response";
			command: "detach_connection";
			success: true;
			/**
			 * Sessions that still count this connection: releasing it would end a turn still running (it
			 * releases when the turn settles), or the host is draining. Empty when every attachment is gone.
			 */
			data: { deferred: string[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subscription_limits";
			success: true;
			/** An account nothing has reported for is absent: unknown, never 0%. */
			data: { accounts: ReadonlyArray<Omit<RpcSubscriptionLimitsEvent, "type">> };
	  }
	| {
			id?: string;
			type: "response";
			command: "list_sessions";
			success: true;
			data: {
				sessions: Array<{
					sessionId: string;
					durableSessionId?: string;
					sessionPath?: string;
					cwd: string;
					name?: string;
					status: "opening" | "open" | "closing" | "closed";
					/** Live client attachments; `0` is a retained session with no client attached. */
					attachments: number;
					/** The session outlives its last attachment; absent from hosts older than this field. */
					retain_on_disconnect?: boolean;
					/** Milliseconds since the session's idle window was last refreshed. */
					idleMs?: number;
					/** The session's tool child (senpi#3566): `none` until its first job, then `live` or `exited`. */
					tool_child?: { state: "none" | "live" | "exited"; generation?: number; pid?: number };
				}>;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "subscribe_sessions";
			success: true;
			data: {
				subscriptionId: string;
				snapshot: readonly SessionStatusRecord[];
				seq: number;
				hostGeneration: string;
				hostInstanceId: string;
			};
	  }
	| { id?: string; type: "response"; command: "unsubscribe_sessions"; success: true }
	| {
			id?: string;
			type: "response";
			command: "set_session_context";
			success: true;
			data: { context: Readonly<Record<string, string | number | boolean>> };
	  };
