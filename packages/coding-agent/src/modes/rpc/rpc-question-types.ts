// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** One question in an RPC `question` UI request. Matches canonical QuestionRequest.questions. */
export type RpcQuestionSpec = {
	id: string;
	header: string;
	question: string;
	options: Array<{ label: string; description?: string }>;
	multiSelect: boolean;
};

export type RpcQuestionAnswers = Record<string, { selected: string[]; text?: string }>;

export type RpcQuestionOutcome =
	| "answered"
	| "comment-submitted"
	| "timed_out"
	| "cancelled"
	| "orphaned-after-restart"
	| "unavailable";

/** Outbound `extension_ui_request` body for method `question`. */
export type RpcQuestionUiRequest = {
	type: "extension_ui_request";
	id: string;
	method: "question";
	requestId: string;
	toolCallId: string;
	waitForAnswer: boolean;
	questions: RpcQuestionSpec[];
	timeout: number;
	askedAtMs: number;
	deadlineAtMs: number;
	remainingMs: number;
};

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			/** Permanent MCP env grant; only a grant_select presentation may answer. */
			grantSelect?: boolean;
			title: string;
			options: string[];
			timeout?: number;
			/** The tool call this dialog approves, when it is a permission request. */
			toolCallId?: string;
			parentToolCallId?: string;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
			toolCallId?: string;
			parentToolCallId?: string;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setSubagentCost";
			costUsd: number | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
			/** Choices offered with the widget; a client sends `command` as a normal prompt when one is picked. */
			widgetActions?: { label: string; command: string }[];
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	// Additive (task 13/14): emitted ONLY when the client advertised the
	// "custom_unsupported" capability. ctx.ui.custom cannot render a third-party
	// component in RPC mode, so a flagged client gets this notice before custom()
	// returns undefined. Default clients never see it (byte-identical behavior).
	| { type: "extension_ui_request"; id: string; method: "custom_unsupported"; extensionName: string }
	| RpcQuestionUiRequest;

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/**
 * Response to an extension UI request. `id` is this frame's correlation id, echoed by its reply;
 * `uiRequestId` names the request answered, and without it `id` does (the short form).
 */
export type RpcExtensionUIResponseFrame = {
	type: "extension_ui_response";
	id: string;
	uiRequestId?: string;
	answerId?: string;
};

export type RpcExtensionUIResponse =
	| (RpcExtensionUIResponseFrame & { value: string })
	| (RpcExtensionUIResponseFrame & { confirmed: boolean })
	| (RpcExtensionUIResponseFrame & { cancelled: true })
	| (RpcExtensionUIResponseFrame & { answers: RpcQuestionAnswers; comment?: string });

/** Inbound draft updates for an open `question` request. */
export type RpcExtensionUIProgress = {
	type: "extension_ui_progress";
	id: string;
	answers?: RpcQuestionAnswers;
	comment?: string;
	sessionId?: string;
};

/** Outbound deadline refresh for an open `question` request. */
export type RpcQuestionUpdatedEvent = {
	type: "question_updated";
	id: string;
	deadlineAtMs: number;
	remainingMs: number;
};

/** Outbound terminal outcome for a `question` request. */
export type RpcQuestionResolvedEvent = {
	type: "question_resolved";
	resolvedBy?: "local_ui" | "rpc_connection" | "control_endpoint";
	id: string;
	requestId: string;
	toolCallId: string;
	outcome: RpcQuestionOutcome;
	answers: RpcQuestionAnswers;
	comment?: string;
	unanswered: string[];
	deadlineAtMs?: number;
};
