/** Permission action: allow (grant), deny (block), or ask (prompt user) */
export type Action = "allow" | "deny" | "ask";

/** A single permission rule with pattern matching */
export type Rule = {
	permission: string;
	pattern: string;
	action: Action;
};

/** Ordered list of rules for evaluation (last match wins) */
export type Ruleset = Rule[];

/** Configuration format for settings.json */
export type PermissionConfig = Record<string, Action | Record<string, Action>>;

export type PermissionPresetName = "full-access" | "workspace" | "accept-edits" | "auto" | "read-only" | "ask";

/** User reply to a permission request */
export type Reply = "once" | "always" | "reject";

/** Final permission decision: user reply or auto-grant from rules */
export type PermissionDecision = Reply | "allow";

/** Permission request sent to user for approval */
export type Request = {
	id: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	always: string[];
	/** Lexical path spellings for display and deny checks; allows use only the resolved targets. */
	originalPaths?: readonly string[];
	/** A wider "Allow always" scope the prompt may offer (tools without a parser, senpi#3403). */
	widerAlways?: { readonly label: string; readonly patterns: string[] };
	metadata: Record<string, unknown>;
	/** The tool call that raised this request (`parentCallID` when another tool issued it). */
	tool?: {
		messageID?: string;
		callID: string;
		parentCallID?: string;
	};
};

/** Input for replying to a permission request */
export type ReplyInput = {
	requestID: string;
	reply: Reply;
	message?: string;
	/** With reply "always": the patterns to approve instead of the request's own (a wider scope). */
	always?: string[];
};

/**
 * The rule every refusal states to the model after its fixed first sentence (clients match that
 * sentence as a prefix): a refused call's purpose is not to be reached by another route. Without it,
 * "this specific tool call" reads as permission to try a different tool.
 */
export const NO_OTHER_ROUTE = "do not get the same result another way (another tool, command, path or host)";

export const DENIAL_IS_FINAL = `Treat this as final for what the call was meant to do: ${NO_OTHER_ROUTE}. Tell the user what was refused, and continue only with work that does not depend on it.`;

/** Error thrown when user rejects a permission request */
export class RejectedError extends Error {
	readonly _tag = "PermissionRejectedError";

	constructor() {
		super(`The user rejected permission to use this specific tool call. ${DENIAL_IS_FINAL}`);
		this.name = "RejectedError";
	}
}

/** Error thrown when user rejects with feedback for correction */
export class CorrectedError extends Error {
	readonly _tag = "PermissionCorrectedError";
	readonly feedback: string;

	constructor(feedback: string) {
		super(
			`The user rejected permission to use this specific tool call with the following feedback: ${feedback}\nFollow the feedback. Unless it tells you otherwise, ${NO_OTHER_ROUTE}.`,
		);
		this.name = "CorrectedError";
		this.feedback = feedback;
	}
}

/** Error thrown when a rule denies the permission */
/** The canonical forms a denied request was decided with, so the refusal can name an identity-matched rule's layer. */
export interface DeniedIdentity {
	readonly canonical: readonly { readonly path: string; readonly foldCase: boolean }[];
	readonly unresolvable?: string;
	readonly failClosed?: boolean;
}

export class DeniedError extends Error {
	readonly _tag = "PermissionDeniedError";
	readonly patterns: string[];
	readonly identity: DeniedIdentity | undefined;

	constructor(patterns: string[], identity?: DeniedIdentity) {
		super(`The user has specified a rule which prevents you from using this specific tool call. ${DENIAL_IS_FINAL}`);
		this.name = "DeniedError";
		this.patterns = patterns;
		this.identity = identity;
	}
}

/** Union of all permission-related errors */
export type PermissionError = RejectedError | CorrectedError | DeniedError;

/** Internal pending request entry */
export type PendingEntry = {
	info: Request;
	resolve: () => void;
	reject: (err: RejectedError | CorrectedError) => void;
};
