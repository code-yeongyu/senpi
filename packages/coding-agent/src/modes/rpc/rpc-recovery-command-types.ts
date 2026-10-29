/** The recovery commands of a socket host (senpi#4272): pages under a checkpoint token or an event lease, and receipts. */
export type RpcRecoveryCommand =
	| { id?: string; type: "cancel_attempt"; admissionId: string }
	/**
	 * One bounded page of a frozen checkpoint component through the recovery-token owner (R4.B3, senpi#4272); answered
	 * only behind `SENPI_ENGINE_SOCKET_COMPACT_UPDATES`. `token`, `admissionId` and `componentRef` come from the
	 * manifest and catalog of a token this connection holds; `cursor` continues a component from the previous page's
	 * answer; `requestId` is the client's own id, so an exact retry answers the same page.
	 */
	| {
			id?: string;
			type: "get_recovery_page";
			token: string;
			admissionId: string;
			componentRef: string;
			requestId: string;
			cursor?: string;
	  }
	/** The same page route under an event lease (S13): an `eventLease` envelope names the lease and its `componentRef`. */
	| {
			id?: string;
			type: "get_recovery_page";
			lease: { kind: "event" | "checkpoint"; id: string };
			admissionId: string;
			componentRef: string;
			requestId: string;
			cursor?: string;
	  }
	/** The consumer's receipt for an event lease, sent only after it committed the content (S13, RULING-65 S13-Q2). */
	| { id?: string; type: "release_recovery"; lease: { kind: "event"; id: string }; admissionId: string };
