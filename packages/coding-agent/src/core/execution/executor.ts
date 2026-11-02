import { prepareAgentToolCall } from "@earendil-works/pi-agent-core";
import type {
	ExecutionEntry,
	ExecutionEvent,
	ExecutionKey,
	LedgerReply,
} from "@earendil-works/pi-agent-core/conformance";
import { errorResult, finalizeBody, type PreparedBody, runBody } from "./executor-body.ts";
import {
	digestOf,
	freezeCall,
	resultValue,
	type StoppedReply,
	stoppedReply,
	stoppedValue,
	toStoreValue,
} from "./executor-freeze.ts";
import type {
	PreparedExecutor,
	PreparedExecutorOptions,
	PrepareReply,
	PrepareRequest,
	ReleaseReply,
	ReleaseRequest,
} from "./executor-types.ts";

const keyId = ({ issuer, commandId }: ExecutionKey): string => JSON.stringify([issuer, commandId]);

function refusal(reply: LedgerReply): { readonly kind: "refused"; readonly reason: string } {
	return { kind: "refused", reason: reply.status === "refused" ? reply.reason : reply.status };
}

// Today's message for a call the response cut off (agent-loop `createIncompleteToolCallErrorMessage`).
function incompleteMessage(name: string, errorMessage: string | undefined): string {
	if (errorMessage !== undefined) {
		return `${errorMessage}${errorMessage.endsWith(".") ? "" : "."} Re-issue the tool call with complete arguments.`;
	}
	return `Tool call "${name}" was not executed: the response ended before the tool call was complete because it hit the output token limit. Re-issue the tool call with complete arguments.`;
}

/** A durable row that already passed admission: answer from it and never run preparation again. */
function fromRow(entry: ExecutionEntry): PrepareReply {
	const progress = entry.progress;
	if ("call" in progress) return { kind: "prepared", call: progress.call };
	if (progress.state !== "settled") return { kind: "refused", reason: progress.state };
	const outcome = progress.outcome;
	if (outcome.reason !== "blocked") return { kind: "refused", reason: "terminal" };
	return stoppedReply(outcome.value) ?? { kind: "refused", reason: "corrupt_blocked_outcome" };
}

/**
 * The prepared executor (design 5.6.1): PREPARE persists effect_possible, runs today's resolution, shim, validation
 * and `tool_call` chain once, and freezes the result; RELEASE dispatches the frozen call at most once and runs the
 * after-hook once. Nothing here is installed on a session; a caller builds one and drives it.
 */
export function createPreparedExecutor(options: PreparedExecutorOptions): PreparedExecutor {
	const { ledger, executor, pipeline } = options;
	const clock = options.clock ?? Date.now;
	const preparations = new Map<string, { readonly admission: string; readonly reply: Promise<PrepareReply> }>();
	const bodies = new Map<string, PreparedBody>();
	const releases = new Map<string, Promise<ReleaseReply>>();

	const step = (key: ExecutionKey, generation: number, event: ExecutionEvent): Promise<LedgerReply> =>
		ledger.apply({ key, generation, actor: { id: executor }, now: clock(), event });

	// A preparation that ends without a frozen call is terminal and durable, so a re-sent prepare (also from a new
	// executor process after restart) gets this reply back instead of a restart-recovered `hand_restarted`.
	async function stop(key: ExecutionKey, generation: number, reply: StoppedReply): Promise<PrepareReply> {
		const recorded = await step(key, generation, { kind: "block", value: stoppedValue(reply) });
		if (recorded.status === "applied") return reply;
		return recorded.status === "replayed" ? fromRow(recorded.entry) : refusal(recorded);
	}

	async function prepareOnce(request: PrepareRequest, requestDigest: string): Promise<PrepareReply> {
		const { call, generation, signal } = request;
		const key = { issuer: request.issuer, commandId: call.id };
		const admitted = await ledger.admit({
			...key,
			executor,
			workspace: request.workspace,
			scope: request.scope,
			generation,
			requestDigest,
			admittedAt: request.admittedAt,
			leaseUntil: request.leaseUntil,
			reconcilable: request.reconcilable ?? false,
		});
		if (admitted.status === "replayed") return fromRow(admitted.entry);
		if (admitted.status !== "applied") return refusal(admitted);
		const preparing = await step(key, generation, { kind: "prepare" });
		if (preparing.status !== "applied") return refusal(preparing);
		if (call.incomplete === true) {
			return stop(key, generation, {
				kind: "blocked",
				result: errorResult(incompleteMessage(call.name, call.errorMessage)),
			});
		}
		const effect = await step(key, generation, { kind: "effect" });
		if (effect.status !== "applied") return refusal(effect);

		const tool = await pipeline.resolve(call, request.context);
		if (!tool) {
			const hint = pipeline.removedToolHint(call.name);
			const text = hint === undefined ? `Tool ${call.name} not found` : `Tool ${call.name} not found. ${hint}`;
			return stop(key, generation, { kind: "blocked", result: errorResult(text) });
		}
		const requestedName = tool.name === call.name ? undefined : call.name;
		const named = requestedName === undefined ? {} : { requestedName };
		try {
			const prepared = prepareAgentToolCall(tool, requestedName === undefined ? call : { ...call, name: tool.name });
			const before = await pipeline.beforeToolCall(
				{
					assistantMessage: request.assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					context: request.context,
				},
				signal,
			);
			if (signal?.aborted)
				return stop(key, generation, { kind: "batch_abort", result: errorResult("Operation aborted") });
			if (before?.block) {
				const result = errorResult(before.reason || "Tool execution was blocked");
				if (before.terminate === true) result.terminate = true;
				return stop(key, generation, { kind: "blocked", result, ...named });
			}
			const frozen = freezeCall(tool.name, prepared.args);
			const freeze = await step(key, generation, { kind: "freeze", call: frozen, awaitingConsent: false });
			if (freeze.status !== "applied") return refusal(freeze);
			bodies.set(keyId(key), {
				tool,
				toolCall: prepared.toolCall,
				args: frozen.args,
				assistantMessage: request.assistantMessage,
				context: request.context,
			});
			return { kind: "prepared", call: frozen, ...named };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return stop(key, generation, { kind: "blocked", result: errorResult(message), ...named });
		}
	}

	async function releaseOnce(request: ReleaseRequest, body: PreparedBody): Promise<ReleaseReply> {
		const { key, generation, signal } = request;
		const released = await ledger.apply({
			key,
			generation,
			actor: request.actor,
			now: clock(),
			event: { kind: "release" },
		});
		if (released.status === "refused" || released.status === "result_expired") return refusal(released);
		const dispatched = await step(key, generation, { kind: "dispatch" });
		if (dispatched.status === "replayed") return { kind: "replayed", entry: dispatched.entry };
		if (dispatched.status !== "applied" || dispatched.entry.progress.state !== "dispatched") {
			return refusal(dispatched);
		}
		const executed = await runBody(body, signal, request.onUpdate ?? (() => {}));
		const { result, isError } = await finalizeBody(body, executed, pipeline, signal);
		const recorded = await step(key, generation, { kind: "result", value: resultValue(result, isError) });
		for (const memo of [bodies, preparations, releases]) memo.delete(keyId(key));
		// A cancel or lease expiry that settled first stays terminal; the late body result is audit only.
		if (recorded.status === "replayed") return { kind: "replayed", entry: recorded.entry };
		if (recorded.status !== "applied") return refusal(recorded);
		return { kind: "settled", toolCall: body.toolCall, result, isError };
	}

	async function settledRow(key: ExecutionKey): Promise<ReleaseReply> {
		const entry = await ledger.read(key);
		const progress = entry?.progress;
		if (entry === undefined || progress === undefined) return { kind: "refused", reason: "not_prepared" };
		// Release on a terminal is refused; a blocked call never had a body to replay.
		if (progress.state === "settled" && progress.outcome.reason === "blocked")
			return { kind: "refused", reason: "blocked" };
		return progress.state === "settled" || progress.state === "acked"
			? { kind: "replayed", entry }
			: { kind: "refused", reason: "not_prepared" };
	}

	return {
		prepare: (request) => {
			const requestDigest = digestOf(toStoreValue({ name: request.call.name, args: request.call.arguments }));
			const admission = JSON.stringify([
				request.generation,
				request.workspace,
				request.scope,
				requestDigest,
				request.admittedAt,
				request.leaseUntil,
				request.reconcilable ?? false,
			]);
			const id = keyId({ issuer: request.issuer, commandId: request.call.id });
			const pending = preparations.get(id);
			if (pending !== undefined && pending.admission === admission) return pending.reply;
			if (pending !== undefined) return Promise.resolve({ kind: "refused", reason: "identity_conflict" });
			const reply = prepareOnce(request, requestDigest);
			preparations.set(id, { admission, reply });
			return reply;
		},
		release: (request) => {
			const id = keyId(request.key);
			const pending = releases.get(id);
			if (pending !== undefined) return pending;
			const body = bodies.get(id);
			if (body === undefined) return settledRow(request.key);
			const reply = releaseOnce(request, body);
			releases.set(id, reply);
			return reply;
		},
	};
}
