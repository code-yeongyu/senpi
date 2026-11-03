import type { AssistantProgress } from "@earendil-works/pi-ai";
import type { ClientMessageIdentity } from "../../core/client-message-identity.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import type {
	RpcAccountFailoverEvent,
	RpcAuthAccountsChangedEvent,
	RpcExtensionEvent,
	RpcExtensionUIRequest,
	RpcOpenQueuedEvent,
	RpcSecretInputSettledEvent,
	RpcSessionParkedEvent,
	RpcSessionReplacedEvent,
} from "./rpc-types.ts";
import type { RpcSocketClosingEvent } from "./socket-closing.ts";

/** The records an `RpcClient` hands to its event listeners (moved out of `rpc-client.ts` with senpi#5322). */
export type RpcProviderAccountEvent = RpcAuthAccountsChangedEvent | RpcAccountFailoverEvent;
export type RpcClientEvent =
	| RpcSecretInputSettledEvent
	| (JsonAgentSessionEvent & ClientMessageIdentity & { readonly clientMessages?: readonly ClientMessageIdentity[] })
	| RpcProviderAccountEvent
	| RpcExtensionEvent
	| RpcExtensionUIRequest
	// The host swapped the live session behind this connection. Part of the public
	// union so a typed client can discriminate on the type and read the new
	// `durableSessionId` without casting: the command response carries only
	// `{ cancelled }`, and a replacement may be driven by another client or an
	// extension, so this is the only channel delivering the new identity.
	| RpcSessionReplacedEvent
	// The host parked a retained session at its idle window. Part of the public union
	// because it REPLACES `session_closed` for that handle: a client that treats it as
	// a close loses the session it was told to reopen by path.
	| RpcSessionParkedEvent
	// The host accepted an open_session and says where it is queued; the client also uses it to
	// switch that open to its post-acknowledgement deadline (senpi#2209).
	| RpcOpenQueuedEvent
	// The engine closes this compact socket next and says why (senpi#5322, RULING-124); best effort, never guaranteed.
	| RpcSocketClosingEvent
	// A compact recovery cut resets each tool call still open at it (senpi#5298, senpi#5300); listeners receive it as is.
	| (Extract<AssistantProgress, { type: "message_tool_arguments_reset" }> & { readonly sessionId?: string })
	| { type: "bash_start" }
	| { type: "bash_end" };
export type RpcEventListener = (event: RpcClientEvent) => void;

export function isProviderAccountEvent(event: RpcClientEvent): event is RpcProviderAccountEvent {
	return event.type === "auth_accounts_changed" || event.type === "account_failover";
}
