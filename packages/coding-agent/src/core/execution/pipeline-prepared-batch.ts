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
 * today's scheduler emits them; the returned outcomes are the calls that started, in source order. A call's command ID
 * is its block position in the batch, not the model's call ID: a model may repeat a call ID inside one message, and
 * today's scheduler runs each such block as its own call. Each batch runs on its own in-memory ledger.
 */
export async function runPreparedBatch(request: PreparedBatchRequest): Promise<AgentToolCallOutcome[]> {
	const { agent, calls, context, assistantMessage, emit, signal } = request;
	const medium = createMemoryStoreMedium();
	const store = openMemoryStore(medium);
	await store.claim(0, 1);
	const admission = createAdmissionLine();
	const base = agentPreparationPipeline(agent);
	// Keyed by the call itself: two blocks of one message may share a call ID but never a call.
	const resolved = new Map<AgentToolCall, AgentTool | undefined>();
	const prepared = createPreparedExecutor({
		ledger: createExecutionLedger({ store, epoch: 1, admission }),
		executor: EXECUTOR,
		pipeline: { ...base, resolve: async (call) => resolved.get(call) },
	});
	const executionIdOf = (index: number): string => String(index);
	const byExecution = new Map(calls.map((call, index) => [executionIdOf(index), call]));
	// Every map below is keyed by execution ID (the block), never by the model's call ID.
	const renamed = new Map<string, AgentToolCall>();
	const named = (id: string, call: AgentToolCall): AgentToolCall => renamed.get(id) ?? call;
	const callOf = (id: string): AgentToolCall => {
		const call = byExecution.get(id);
		if (call === undefined) throw new Error(`prepared pipeline: unknown execution ${id}`);
		return call;
	};
	const started = new Set<string>();
	const pending = new Map<string, AgentToolCallOutcome>();
	const finalized = new Map<string, AgentToolCallOutcome>();
	const finish = async (id: string, outcome: AgentToolCallOutcome): Promise<void> => {
		finalized.set(id, outcome);
		await emitToolExecutionEnd(outcome, emit);
	};
	const aborted = (call: AgentToolCall): AgentToolCallOutcome => ({
		toolCall: call,
		result: createErrorToolResult("Operation aborted"),
		isError: true,
	});

	const endpoint: BatchExecutor = {
		prepare: async (ref) => {
			const id = ref.executionId;
			const call = callOf(id);
			if (signal?.aborted && started.size > 0) return { kind: "batch_abort" };
			const tool = call.incomplete === true ? undefined : await base.resolve(call, context);
			resolved.set(call, tool);
			if (tool !== undefined && tool.name !== call.name) renamed.set(id, { ...call, name: tool.name });
			await emit({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: tool?.name ?? call.name,
				args: call.arguments,
			});
			started.add(id);
			const reply = await prepared.prepare({
				issuer: ISSUER,
				commandId: id,
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
				pending.set(id, aborted(named(id, call)));
				return { kind: "batch_abort" };
			}
			if (reply.kind === "prepared") return { kind: "prepared", frozenDigest: reply.call.digest };
			if (reply.kind === "prepared_awaiting_consent")
				return { kind: "prepared_awaiting_consent", frozenDigest: reply.call.digest };
			if (reply.kind === "refused") throw new Error(`prepared pipeline refused ${call.id}: ${reply.reason}`);
			const result =
				reply.kind === "blocked" && reply.requestedName !== undefined && tool !== undefined
					? withToolNameCorrection(reply.result, reply.requestedName, tool.name)
					: reply.result;
			pending.set(id, { toolCall: named(id, call), result, isError: true });
			const value = toStoreValue({ content: result.content ?? [] });
			return reply.kind === "blocked" ? { kind: "blocked", result: value } : { kind: "batch_abort" };
		},
		release: async (ref) => {
			const id = ref.executionId;
			const call = callOf(id);
			const reply = await prepared.release({
				key: { issuer: ISSUER, commandId: id },
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
				await finish(id, { toolCall: reply.toolCall, result, isError: reply.isError });
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
				id,
				signal?.aborted
					? aborted(named(id, call))
					: { toolCall: named(id, call), result: reply.result, isError: true },
			);
			return { kind: "settled", outcome: { reason: "cancelled", hooksRan: true, uncertain: false } };
		},
		abort: async (ref) => {
			const id = ref.executionId;
			const call = callOf(id);
			if (started.has(id))
				await finish(
					id,
					signal?.aborted ? aborted(named(id, call)) : (pending.get(id) ?? aborted(named(id, call))),
				);
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
		calls: calls.map((call, index) => ({
			executionId: executionIdOf(index),
			executor: EXECUTOR,
			name: call.name,
			args: toStoreValue(call.arguments),
			sequential: isSequential(context, call.name),
		})),
	};
	await createBatchCoordinator({ issuer: ISSUER, store, epoch: 1, admission, executor: () => endpoint }).run(plan);
	return calls.flatMap((_call, index) => {
		const id = executionIdOf(index);
		const outcome = finalized.get(id);
		return started.has(id) && outcome !== undefined ? [outcome] : [];
	});
}
