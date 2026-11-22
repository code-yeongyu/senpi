/** Outbound: a host session asks the client that offers `session_relocation` (docs/rpc.md). */
export type RpcHostRequest =
	| { type: "host_request"; id: string; method: "list_relocation_targets"; sessionId?: string }
	| {
			type: "host_request";
			id: string;
			method: "relocate_session";
			target: string;
			reason: string;
			sessionId?: string;
	  };

/** Inbound answer to one `host_request`, under its `id`: `data` for an answer, `error` when the client failed. */
export type RpcHostResponse = {
	type: "host_response";
	id: string;
	sessionId?: string;
	data?: unknown;
	error?: string;
};

/** Outbound: the run that scheduled an accepted move settled; the host runs the move now. */
export type RpcRelocationDueEvent = {
	type: "relocation_due";
	moveId: string;
	target: string;
	reason: string;
	sessionId?: string;
};
