import type { RequestId } from "../protocol/index.ts";
import {
	APPROVAL_DECISIONS,
	type ApprovalDecision,
	type ApprovalKind,
	type ApprovalOutcome,
	type ApprovalPayload,
	type ApprovalResponse,
	type AppServerApprovalRequest,
	CANCEL_REASON,
	NO_SUBSCRIBER_REASON,
	type SendToThreadSubscribers,
} from "./approval-types.ts";

type PendingApproval = Readonly<{
	threadId: string;
	request: AppServerApprovalRequest;
	allowKey: string | undefined;
	resolve: (outcome: ApprovalOutcome) => void;
}>;

export class ApprovalBridge {
	private nextServerRequestId = 0;
	private readonly pending = new Map<RequestId, PendingApproval>();
	private readonly sessionAllows = new Set<string>();
	private readonly sendToThreadSubscribers: SendToThreadSubscribers;

	constructor(sendToThreadSubscribers: SendToThreadSubscribers) {
		this.sendToThreadSubscribers = sendToThreadSubscribers;
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	requestApproval(threadId: string, kind: ApprovalKind, payload: ApprovalPayload): Promise<ApprovalOutcome> {
		const allowKey = createAllowKey(threadId, kind, payload);
		if (allowKey && this.sessionAllows.has(allowKey)) {
			return Promise.resolve({ allow: true, decision: "acceptForSession" });
		}
		const requestId = this.nextServerRequestId;
		this.nextServerRequestId += 1;
		const request = buildApprovalRequest(threadId, requestId, kind, payload);
		return new Promise((resolve) => {
			this.pending.set(requestId, { threadId, request, allowKey, resolve });
			if (this.sendToThreadSubscribers(threadId, request) > 0) {
				return;
			}
			this.pending.delete(requestId);
			resolve({ allow: false, decision: "decline", reason: NO_SUBSCRIBER_REASON });
		});
	}

	resolveResponse(response: ApprovalResponse): boolean {
		const pending = this.pending.get(response.id);
		if (!pending) {
			return false;
		}
		const decision = readDecision(response);
		this.pending.delete(response.id);
		if (decision === "acceptForSession" && pending.allowKey) {
			this.sessionAllows.add(pending.allowKey);
		}
		this.emitResolved(pending.threadId, response.id);
		pending.resolve(decisionToOutcome(decision, readReason(response)));
		return true;
	}

	/**
	 * Re-sends every pending approval request for a thread to its current
	 * subscribers. Wired to thread subscription (resume/start) so a client that
	 * reconnects mid-approval receives the blocking request again instead of the
	 * turn hanging forever with nobody able to answer. Duplicate deliveries are
	 * safe: responses resolve first-responder-wins and late ones are ignored.
	 */
	replayPendingForThread(threadId: string): number {
		let replayed = 0;
		for (const pending of this.pending.values()) {
			if (pending.threadId !== threadId) {
				continue;
			}
			this.sendToThreadSubscribers(threadId, pending.request);
			replayed += 1;
		}
		return replayed;
	}

	cancelPendingForThread(threadId: string): number {
		let cancelled = 0;
		for (const [requestId, pending] of Array.from(this.pending.entries())) {
			if (pending.threadId !== threadId) {
				continue;
			}
			this.pending.delete(requestId);
			this.emitResolved(threadId, requestId);
			pending.resolve({ allow: false, decision: "cancel", reason: CANCEL_REASON });
			cancelled += 1;
		}
		return cancelled;
	}

	private emitResolved(threadId: string, requestId: RequestId): void {
		this.sendToThreadSubscribers(threadId, {
			method: "serverRequest/resolved",
			params: { threadId, requestId },
		});
	}
}

function buildApprovalRequest(
	threadId: string,
	requestId: RequestId,
	kind: ApprovalKind,
	payload: ApprovalPayload,
): AppServerApprovalRequest {
	const base = {
		threadId,
		turnId: payload.turnId ?? "turn-approval",
		itemId: payload.itemId ?? (kind === "commandExecution" ? "approval-command" : "approval-file-change"),
		startedAtMs: Date.now(),
	};
	if (kind === "fileChange") {
		return {
			id: requestId,
			method: "item/fileChange/requestApproval",
			params: { ...base, reason: payload.reason ?? null, grantRoot: payload.grantRoot ?? null },
		};
	}
	return {
		id: requestId,
		method: "item/commandExecution/requestApproval",
		params: {
			...base,
			approvalId: payload.approvalId ?? null,
			environmentId: payload.environmentId ?? null,
			reason: payload.reason ?? null,
			command: payload.command ?? null,
			cwd: payload.cwd ?? null,
			availableDecisions: [...APPROVAL_DECISIONS],
		},
	};
}

function decisionToOutcome(decision: ApprovalDecision, reason: string | undefined): ApprovalOutcome {
	if (decision === "accept" || decision === "acceptForSession") return { allow: true, decision };
	return reason ? { allow: false, decision, reason } : { allow: false, decision };
}

function readDecision(response: ApprovalResponse): ApprovalDecision {
	const decision = isRecord(response.result) ? response.result.decision : undefined;
	return isApprovalDecision(decision) ? decision : "cancel";
}

function readReason(response: ApprovalResponse): string | undefined {
	const resultReason = isRecord(response.result) ? (response.result.reason ?? response.result.message) : undefined;
	const errorReason = isRecord(response.error) ? response.error.message : undefined;
	const reason = typeof resultReason === "string" ? resultReason : errorReason;
	return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

function createAllowKey(threadId: string, kind: ApprovalKind, payload: ApprovalPayload): string | undefined {
	if (!payload.toolName || typeof payload.command !== "string") return undefined;
	return `${threadId}\0${kind}\0${payload.toolName}\0${payload.command}`;
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
	return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
