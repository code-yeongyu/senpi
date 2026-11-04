import { prepareAgentToolCall } from "../../agent-loop.ts";
import type { AgentTool } from "../../types.ts";
import { canonicalDigest } from "../canonical-digest.ts";
import type { ExecutionEntry, ExecutionEvent, ExecutionKey, LedgerReply } from "../ledger-types.ts";
import { errorResult, finalizeBody, messageOf, type PreparedBody, runBody } from "./executor-body.ts";
import {
	freezeCall,
	resultValue,
	type StoppedReply,
	stoppedReply,
	stoppedValue,
	toStoreValue,
} from "./executor-freeze.ts";
import type {
	ConsentReply,
	ConsentRequest,
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
	if (progress.state === "prepared_awaiting_consent")
		return { kind: "prepared_awaiting_consent", call: progress.call };
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

		let tool: AgentTool | undefined;
		try {
			tool = await pipeline.resolve(call, request.context);
		} catch (error) {
			return stop(key, generation, { kind: "blocked", result: errorResult(messageOf(error)) });
		}
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
			const frozen = await freezeCall(tool.name, prepared.args);
			// Gate A approved this exact request; it covers the frozen call only when preparation left the call unchanged.
			const covered =
				request.authorizedDigest === requestDigest &&
				(await freezeCall(call.name, toStoreValue(call.arguments))).digest === frozen.digest;
			const awaitingConsent =
				options.consent !== undefined &&
				!covered &&
				options.consent.needsConsent({ name: frozen.name, args: frozen.args });
			const freeze = await step(key, generation, { kind: "freeze", call: frozen, awaitingConsent });
			if (freeze.status !== "applied") return refusal(freeze);
			pipeline.afterFreeze(prepared.args, frozen.args);
			bodies.set(keyId(key), {
				...named,
				tool,
				toolCall: prepared.toolCall,
				args: frozen.args,
				assistantMessage: request.assistantMessage,
				context: request.context,
			});
			return { kind: awaitingConsent ? "prepared_awaiting_consent" : "prepared", call: frozen, ...named };
		} catch (error) {
			return stop(key, generation, { kind: "blocked", result: errorResult(messageOf(error)), ...named });
		}
	}

	async function terminalRow(key: ExecutionKey): Promise<ReleaseReply> {
		const entry = await ledger.read(key);
		if (entry === undefined) return { kind: "refused", reason: "not_found" };
		const progress = entry.progress;
		// A blocked call never had a body: release on it is refused, not replayed.
		if (progress.state === "settled" && progress.outcome.reason === "blocked")
			return { kind: "refused", reason: "blocked" };
		return { kind: "replayed", entry };
	}

	async function runReleased(request: ReleaseRequest, body: PreparedBody): Promise<ReleaseReply> {
		const { key, generation, signal } = request;
		const dispatched = await step(key, generation, { kind: "dispatch" });
		if (dispatched.status === "replayed") return { kind: "replayed", entry: dispatched.entry };
		if (dispatched.status !== "applied" || dispatched.entry.progress.state !== "dispatched") {
			return refusal(dispatched);
		}
		const executed = await runBody(
			body,
			signal,
			request.onUpdateFor?.(body.toolCall) ?? request.onUpdate ?? (() => {}),
		);
		const { result, isError } = await finalizeBody(body, executed, pipeline, signal);
		const value = resultValue(result, isError, body.requestedName);
		const recorded = await step(key, generation, { kind: "result", value });
		for (const memo of [bodies, preparations, releases]) memo.delete(keyId(key));
		// A cancel or lease expiry that settled first stays terminal; the late body result is audit only.
		if (recorded.status === "replayed") return { kind: "replayed", entry: recorded.entry };
		if (recorded.status !== "applied") return refusal(recorded);
		const named = body.requestedName === undefined ? {} : { requestedName: body.requestedName };
		return { kind: "settled", toolCall: body.toolCall, result, isError, ...named };
	}

	// Every release reaches the ledger with its own actor and generation before any memo is read or written, so a
	// wrong actor or an old generation is refused there and can never answer, or block, the issuer's own release.
	async function release(request: ReleaseRequest): Promise<ReleaseReply> {
		const { key, generation } = request;
		const released = await ledger.apply({
			key,
			generation,
			actor: request.actor,
			now: clock(),
			event: { kind: "release" },
		});
		if (released.status === "refused") return released.reason === "terminal" ? terminalRow(key) : refusal(released);
		if (released.status === "result_expired") return refusal(released);
		const id = keyId(key);
		const pending = releases.get(id);
		if (pending !== undefined) return pending;
		const body = bodies.get(id);
		if (body === undefined) return { kind: "refused", reason: "not_prepared" };
		// Today's loop never starts a body once the run is aborted; the call stays released for the issuer's abort.
		if (request.signal?.aborted) return { kind: "aborted", result: errorResult("Operation aborted") };
		const reply = runReleased(request, body);
		releases.set(id, reply);
		void reply.catch(() => releases.get(id) === reply && releases.delete(id));
		return reply;
	}

	// An approval reaches the ledger as the issuer's own `consent` event and only for the frozen call it names; a lease
	// that ran out first settles the call `lease_expired`, so the approval answers with that terminal row.
	async function consent(request: ConsentRequest): Promise<ConsentReply> {
		const entry = await ledger.read(request.key);
		if (entry === undefined) return { kind: "refused", reason: "not_found" };
		if ("call" in entry.progress && entry.progress.call.digest !== request.frozenDigest)
			return { kind: "refused", reason: "frozen_digest_mismatch" };
		const reply = await ledger.apply({
			key: request.key,
			generation: request.generation,
			actor: request.actor,
			now: clock(),
			event: { kind: "consent" },
		});
		if (reply.status === "applied" && reply.entry.progress.state === "prepared") return { kind: "prepared" };
		// The issuer's re-sent approval (the brain restarted before recording the first reply) finds the call prepared.
		if (reply.status === "refused" && reply.reason === "invalid_transition" && entry.progress.state === "prepared")
			return { kind: "prepared" };
		if (reply.status === "applied" || reply.status === "replayed") return { kind: "replayed", entry: reply.entry };
		if (reply.status === "refused" && reply.reason === "terminal") {
			const terminal = await ledger.read(request.key);
			return terminal === undefined
				? { kind: "refused", reason: "not_found" }
				: { kind: "replayed", entry: terminal };
		}
		return refusal(reply);
	}

	return {
		consent,
		prepare: async (request) => {
			const { name, arguments: args, incomplete, errorMessage } = request.call;
			const requestDigest = await canonicalDigest(toStoreValue({ name, args, incomplete, errorMessage }));
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
			if (pending !== undefined) return { kind: "refused", reason: "identity_conflict" };
			const reply = prepareOnce(request, requestDigest);
			preparations.set(id, { admission, reply });
			// Only a prepared call keeps its memo (release needs it); every other reply is durable or retryable.
			const forget = () => preparations.get(id)?.reply === reply && preparations.delete(id);
			void reply.then(
				(settled) => settled.kind === "prepared" || settled.kind === "prepared_awaiting_consent" || forget(),
				forget,
			);
			return reply;
		},
		release,
	};
}
