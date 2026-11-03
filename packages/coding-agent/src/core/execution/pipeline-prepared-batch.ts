import {
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentTool,
	type AgentToolCall,
	type AgentToolCallOutcome,
	type BatchExecutor,
	type BatchPlan,
	createAdmissionLine,
	createBatchCoordinator,
	createExecutionLedger,
	createMemoryStoreMedium,
	openMemoryStore,
	createErrorToolResult,
	emitToolExecutionEnd,
	emitToolExecutionUpdate,
	resolveToolNameAlias,
	withToolNameCorrection,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createPreparedExecutor } from "./executor.ts";
import { toStoreValue } from "./executor-freeze.ts";
import { agentPreparationPipeline } from "./executor-pipeline.ts";

const ISSUER = "loop";
const EXECUTOR = "local";
const LEASE_MS = 24 * 60 * 60 * 1000;

type Emit = (event: AgentEvent) => Promise<void> | void;

export interface PreparedBatchRequest {
	readonly agent: Agent;
	readonly calls: readonly AgentToolCall[];
	readonly scope: { readonly id: string; readonly root: string };
	readonly context: AgentContext;
	readonly assistantMessage: AssistantMessage;
	readonly emit: Emit;
	readonly signal?: AbortSignal;
}

/** The scheduler's sequential test, decided before preparation: exact name, then the alias rule; an unresolved name runs in parallel. */
function isSequential(context: AgentContext, name: string): boolean {
	const tools = context.tools ?? [];
	const named = resolveToolNameAlias(
		name,
		tools.map((tool) => tool.name),
	);
	const tool =
		tools.find((candidate) => candidate.name === name) ?? tools.find((candidate) => candidate.name === named);
	return tool?.executionMode === "sequential";
}

/**
 * Runs one batch through the prepared pipeline (S18b): the batch coordinator prepares every call in source order on the
 * in-process prepared executor, decides once, then releases by dependencies. The loop's events are emitted where
 * today's scheduler emits them; the returned outcomes are the calls that started, in source order. Each batch runs on
 * its own in-memory ledger, because a call's command ID is the model's call ID, which providers may reuse across turns.
 */
export async function runPreparedBatch(request: PreparedBatchRequest): Promise<AgentToolCallOutcome[]> {
	const { agent, calls, context, assistantMessage, emit, signal } = request;
	const medium = createMemoryStoreMedium();
	const store = openMemoryStore(medium);
	await store.claim(0, 1);
	const admission = createAdmissionLine();
	const base = agentPreparationPipeline(agent);
	const resolved = new Map<string, AgentTool | undefined>();
	const prepared = createPreparedExecutor({
		ledger: createExecutionLedger({ store, epoch: 1, admission }),
		executor: EXECUTOR,
		pipeline: { ...base, resolve: async (call) => resolved.get(call.id) },
	});
	const byId = new Map(calls.map((call) => [call.id, call]));
	if (byId.size !== calls.length)
		throw new Error("prepared pipeline: duplicate tool call id in one batch; each call needs its own id");
	const renamed = new Map<string, AgentToolCall>();
	const named = (call: AgentToolCall): AgentToolCall => renamed.get(call.id) ?? call;
	const callOf = (id: string): AgentToolCall => {
		const call = byId.get(id);
		if (call === undefined) throw new Error(`prepared pipeline: unknown call ${id}`);
		return call;
	};
	const started = new Set<string>();
	const pending = new Map<string, AgentToolCallOutcome>();
	const finalized = new Map<string, AgentToolCallOutcome>();
	const finish = async (outcome: AgentToolCallOutcome): Promise<void> => {
		finalized.set(outcome.toolCall.id, outcome);
		await emitToolExecutionEnd(outcome, emit);
	};
	const aborted = (call: AgentToolCall): AgentToolCallOutcome => ({
		toolCall: call,
		result: createErrorToolResult("Operation aborted"),
		isError: true,
	});

	const endpoint: BatchExecutor = {
		prepare: async (ref) => {
			const call = callOf(ref.executionId);
			if (signal?.aborted) return { kind: "batch_abort" };
			const tool = call.incomplete === true ? undefined : await base.resolve(call, context);
			resolved.set(call.id, tool);
			if (tool !== undefined && tool.name !== call.name) renamed.set(call.id, { ...call, name: tool.name });
			await emit({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: tool?.name ?? call.name,
				args: call.arguments,
			});
			started.add(call.id);
			const reply = await prepared.prepare({
				issuer: ISSUER,
				generation: ref.generation,
				workspace: ref.workspace,
				scope: ref.scope,
				call,
				assistantMessage,
				context,
				admittedAt: ref.admittedAt,
				leaseUntil: ref.leaseUntil,
				...(signal === undefined ? {} : { signal }),
			});
			if (signal?.aborted) {
				pending.set(call.id, aborted(named(call)));
				return { kind: "batch_abort" };
			}
			if (reply.kind === "prepared") return { kind: "prepared", frozenDigest: reply.call.digest };
			if (reply.kind === "refused") throw new Error(`prepared pipeline refused ${call.id}: ${reply.reason}`);
			const result =
				reply.kind === "blocked" && reply.requestedName !== undefined && tool !== undefined
					? withToolNameCorrection(reply.result, reply.requestedName, tool.name)
					: reply.result;
			pending.set(call.id, { toolCall: named(call), result, isError: true });
			const value = toStoreValue({ content: result.content ?? [] });
			return reply.kind === "blocked" ? { kind: "blocked", result: value } : { kind: "batch_abort" };
		},
		release: async (ref) => {
			const call = callOf(ref.executionId);
			const reply = await prepared.release({
				key: { issuer: ISSUER, commandId: call.id },
				generation: ref.generation,
				actor: { id: ISSUER },
				onUpdateFor: (toolCall) => emitToolExecutionUpdate(toolCall, emit),
				...(signal === undefined ? {} : { signal }),
			});
			if (reply.kind === "settled") {
				const result =
					reply.requestedName === undefined
						? reply.result
						: withToolNameCorrection(reply.result, reply.requestedName, reply.toolCall.name);
				await finish({ toolCall: reply.toolCall, result, isError: reply.isError });
				return {
					kind: "settled",
					outcome: {
						reason: "result",
						value: toStoreValue(result.content ?? []),
						hooksRan: true,
						uncertain: false,
					},
				};
			}
			if (reply.kind !== "aborted") throw new Error(`prepared pipeline: release ${reply.kind} for ${call.id}`);
			await finish(
				signal?.aborted ? aborted(named(call)) : { toolCall: named(call), result: reply.result, isError: true },
			);
			return { kind: "settled", outcome: { reason: "cancelled", hooksRan: true, uncertain: false } };
		},
		abort: async (ref) => {
			const call = callOf(ref.executionId);
			if (started.has(call.id))
				await finish(signal?.aborted ? aborted(named(call)) : (pending.get(call.id) ?? aborted(named(call))));
			return { kind: "settled", outcome: { reason: "cancelled", hooksRan: false, uncertain: false } };
		},
	};

	const now = Date.now();
	const plan: BatchPlan = {
		batchId: crypto.randomUUID(),
		scope: request.scope.id,
		workspace: request.scope.root,
		generation: 1,
		admittedAt: now,
		leaseUntil: now + LEASE_MS,
		calls: calls.map((call) => ({
			executionId: call.id,
			executor: EXECUTOR,
			name: call.name,
			args: toStoreValue(call.arguments),
			sequential: isSequential(context, call.name),
		})),
	};
	await createBatchCoordinator({ issuer: ISSUER, store, epoch: 1, admission, executor: () => endpoint }).run(plan);
	return calls.flatMap((call) => {
		const outcome = finalized.get(call.id);
		return started.has(call.id) && outcome !== undefined ? [outcome] : [];
	});
}
