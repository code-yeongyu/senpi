import type { PendingInput, PendingInputFailure, PendingInputMode, SupersededVersion } from "./pending-input-types.ts";

export type PendingInputState = "queued" | "edited" | "sending" | "delivered" | "removed" | "failed";

export type PendingInputAction = "edit" | "remove" | "copy" | "retry" | "check_delivery";

export type PendingInputStatusCode =
	| "queued_follow_up"
	| "queued_steer"
	| "edited"
	| "sending"
	| "delivered"
	| "applied"
	| "removed"
	| "failed"
	| "delivery_unconfirmed";

export interface PendingInputProjection {
	readonly clientMessageId: string;
	readonly state: PendingInputState;
	readonly text: string;
	readonly requestedMode: PendingInputMode;
	readonly revision: number;
	readonly statusCode: PendingInputStatusCode;
	readonly statusText: string;
	readonly actions: readonly PendingInputAction[];
	/** True while the input still waits; surfaces draw the pending outline only then. */
	readonly pendingDecoration: boolean;
	readonly failure?: PendingInputFailure;
	readonly supersededVersions: readonly SupersededVersion[];
}

/** What every surface renders for one input; the actions offered are decided here, never by a client. */
export function projectPendingInput(input: PendingInput): PendingInputProjection {
	const base = {
		clientMessageId: input.clientMessageId,
		text: input.text,
		requestedMode: input.requestedMode,
		revision: input.revision,
		supersededVersions: input.superseded,
	};
	switch (input.phase) {
		case "queued": {
			const queued = queuedStatus(input.requestedMode);
			return input.hasEdits
				? {
						...base,
						state: "edited",
						statusCode: "edited",
						statusText: `Edited - ${queued.text}`,
						actions: ["edit", "remove", "copy"],
						pendingDecoration: true,
					}
				: {
						...base,
						state: "queued",
						statusCode: queued.code,
						statusText: queued.text,
						actions: ["edit", "remove", "copy"],
						pendingDecoration: true,
					};
		}
		case "sending":
			return {
				...base,
				state: "sending",
				statusCode: "sending",
				statusText: "Sending",
				actions: ["copy"],
				pendingDecoration: true,
			};
		case "delivered":
			return input.deliveredBy === "handled"
				? {
						...base,
						state: "delivered",
						statusCode: "applied",
						statusText: "Applied",
						actions: [],
						pendingDecoration: false,
					}
				: {
						...base,
						state: "delivered",
						statusCode: "delivered",
						statusText: "",
						actions: [],
						pendingDecoration: false,
					};
		case "removed":
			return {
				...base,
				state: "removed",
				statusCode: "removed",
				statusText: "Removed",
				actions: ["copy"],
				pendingDecoration: false,
			};
		case "failed":
			return failedProjection(base, input.failure);
	}
}

function queuedStatus(mode: PendingInputMode): { readonly code: PendingInputStatusCode; readonly text: string } {
	return mode === "steer"
		? { code: "queued_steer", text: "Steering - reaches the agent at its next step" }
		: { code: "queued_follow_up", text: "Queued - sent after this turn" };
}

function failedProjection(
	base: Pick<PendingInputProjection, "clientMessageId" | "text" | "requestedMode" | "revision" | "supersededVersions">,
	failure: PendingInputFailure | undefined,
): PendingInputProjection {
	if (failure === undefined || failure.delivery === "uncertain") {
		return {
			...base,
			state: "failed",
			statusCode: "delivery_unconfirmed",
			statusText: "Delivery could not be confirmed",
			actions: ["check_delivery", "copy"],
			pendingDecoration: true,
			...(failure === undefined ? {} : { failure }),
		};
	}
	return {
		...base,
		state: "failed",
		statusCode: "failed",
		statusText: `Failed: ${failure.reason}`,
		actions: ["retry", "remove", "copy"],
		pendingDecoration: true,
		failure,
	};
}
