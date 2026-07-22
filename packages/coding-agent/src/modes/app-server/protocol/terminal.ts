export type NonSteerableTurnKind = "review" | "compact";

export type CodexErrorInfo =
	| "contextWindowExceeded"
	| "sessionBudgetExceeded"
	| "usageLimitExceeded"
	| "serverOverloaded"
	| "cyberPolicy"
	| "internalServerError"
	| "unauthorized"
	| "badRequest"
	| "threadRollbackFailed"
	| "sandboxError"
	| "other"
	| { readonly httpConnectionFailed: { readonly httpStatusCode: number | null } }
	| { readonly responseStreamConnectionFailed: { readonly httpStatusCode: number | null } }
	| { readonly responseStreamDisconnected: { readonly httpStatusCode: number | null } }
	| { readonly responseTooManyFailedAttempts: { readonly httpStatusCode: number | null } }
	| { readonly activeTurnNotSteerable: { readonly turnKind: NonSteerableTurnKind } };

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type TurnError = {
	readonly message: string;
	readonly codexErrorInfo: CodexErrorInfo | null;
	readonly additionalDetails: string | null;
};

export type ErrorNotification = {
	readonly error: TurnError;
	readonly willRetry: boolean;
	readonly threadId: string;
	readonly turnId: string;
};
