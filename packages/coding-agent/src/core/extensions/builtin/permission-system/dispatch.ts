import type { ExtensionContext } from "../../types.ts";
import { DeniedError } from "./types.ts";

export interface DispatchIdentity {
	readonly owner: object;
	readonly metadata: string;
	readonly operation?: string;
}

export interface DispatchRequest {
	readonly toolCallId: string;
	readonly parentToolCallId?: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly identity: DispatchIdentity;
}

export interface DispatchPolicy {
	readonly action: "allow" | "ask" | "deny";
	readonly fingerprint: string;
}

export interface DispatchAuthorizer {
	policy(request: DispatchRequest, ctx: ExtensionContext): DispatchPolicy;
	ask(request: DispatchRequest, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<void>;
}

interface Approval {
	readonly registration: DispatchRegistration;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: string;
	readonly identity: DispatchIdentity;
	readonly policy: DispatchPolicy;
}

interface DispatchRegistration {
	readonly authorizer: DispatchAuthorizer;
	readonly retired: AbortController;
}

const authorizers = new WeakMap<object, DispatchRegistration>();
// AgentSession passes this validated object unchanged from preflight to execution.
// Identical calls, including calls with duplicate provider IDs, get distinct objects.
const approvals = new WeakMap<object, Approval>();

/** Retirement cannot remove the authorizer installed by a newer extension load. */
export function registerDispatchAuthorizer(session: object, authorizer: DispatchAuthorizer): () => void {
	const previous = authorizers.get(session);
	const registration: DispatchRegistration = { authorizer, retired: new AbortController() };
	authorizers.set(session, registration);
	previous?.retired.abort(new Error("Permission authorizer was retired"));
	return () => {
		if (authorizers.get(session) === registration) authorizers.delete(session);
		registration.retired.abort(new Error("Permission authorizer was retired"));
	};
}

export function hasDispatchAuthorizer(session: object): boolean {
	return authorizers.has(session);
}

/** Keep the policy and operation that were actually presented, not their post-reply replacements. */
export function prepareDispatchApproval(session: object, request: DispatchRequest, policy: DispatchPolicy): () => void {
	const registration = authorizers.get(session);
	if (!registration) throw new Error("Permission authorizer is unavailable");
	const approval: Approval = {
		registration,
		toolCallId: request.toolCallId,
		toolName: request.toolName,
		input: JSON.stringify(request.input),
		identity: { ...request.identity },
		policy: { ...policy },
	};
	return () => {
		if (authorizers.get(session) !== registration) throw new Error("Permission authorizer was retired");
		approvals.set(request.input, approval);
	};
}

export function forgetDispatchApproval(input: object): void {
	approvals.delete(input);
}

function matches(
	approval: Approval | undefined,
	registration: DispatchRegistration,
	request: DispatchRequest,
	policy: DispatchPolicy,
): boolean {
	return (
		approval?.registration === registration &&
		approval.toolCallId === request.toolCallId &&
		approval.toolName === request.toolName &&
		approval.input === JSON.stringify(request.input) &&
		approval.identity.owner === request.identity.owner &&
		approval.identity.metadata === request.identity.metadata &&
		approval.policy.action === policy.action &&
		approval.policy.fingerprint === policy.fingerprint
	);
}

/** Await only this caller's approval; aborting it does not retire another caller's authority. */
async function awaitApproval(pending: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return pending;
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	try {
		await Promise.race([pending, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Resolve live permission after MCP readiness. The returned synchronous fence must
 * pass immediately before dispatch; a false result requires preparation again.
 */
export async function authorizeToolDispatch(
	session: object,
	request: DispatchRequest,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<() => boolean> {
	signal?.throwIfAborted();
	const registration = authorizers.get(session);
	if (!registration) throw new Error("Permission authorizer is unavailable");
	const policy = registration.authorizer.policy(request, ctx);
	if (policy.action === "deny") throw new DeniedError(["*"]);
	if (policy.action === "ask" && !matches(approvals.get(request.input), registration, request, policy)) {
		const approve = prepareDispatchApproval(session, request, policy);
		const waitSignal =
			signal === undefined ? registration.retired.signal : AbortSignal.any([signal, registration.retired.signal]);
		waitSignal.throwIfAborted();
		await awaitApproval(registration.authorizer.ask(request, ctx, waitSignal), waitSignal);
		signal?.throwIfAborted();
		approve();
	}
	const approvedInput = JSON.stringify(request.input);
	const approvedIdentity = { ...request.identity };
	return () => {
		if (signal?.aborted || authorizers.get(session) !== registration) return false;
		if (JSON.stringify(request.input) !== approvedInput) return false;
		if (
			request.identity.owner !== approvedIdentity.owner ||
			request.identity.metadata !== approvedIdentity.metadata
		) {
			return false;
		}
		const current = registration.authorizer.policy(request, ctx);
		if (current.action === "deny") return false;
		return current.action === "allow" || matches(approvals.get(request.input), registration, request, current);
	};
}
