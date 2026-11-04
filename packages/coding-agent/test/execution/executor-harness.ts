import type { AgentToolCall, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { createExecutionLedger, type ExecutionLedger } from "../../../agent/src/execution/ledger.ts";
import type { ExecutionEntry } from "../../../agent/src/execution/ledger-types.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createPreparedExecutor } from "../../../agent/src/execution/prepared/executor.ts";
import { agentPreparationPipeline } from "../../../agent/src/execution/prepared/executor-pipeline.ts";
import type { PrepareReply, ReleaseReply } from "../../../agent/src/execution/prepared/executor-types.ts";

const ISSUER = "brain";
const ADMITTED_AT = Date.now();

export interface SessionExecutor {
	prepare(id: string, name: string, args: JsonObject, signal?: AbortSignal): Promise<PrepareReply>;
	release(id: string): Promise<ReleaseReply>;
	row(id: string): Promise<ExecutionEntry | undefined>;
	/** A new executor process: fresh memory over the same store, after the ledger's restart recovery. */
	restart(): Promise<void>;
}

/** A prepared executor over a fresh in-memory ledger, driving `session`'s own preparation pipeline in process. */
export async function sessionExecutor(
	session: AgentSession,
	onEffect: () => void = () => {},
): Promise<SessionExecutor> {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const open = (): ExecutionLedger =>
		createExecutionLedger({ store: openMemoryStore(medium), epoch: 1, admission: createAdmissionLine() });
	const build = (ledger: ExecutionLedger) =>
		createPreparedExecutor({
			ledger: {
				...ledger,
				apply: async (command) => {
					const reply = await ledger.apply(command);
					if (command.event.kind === "effect" && reply.status === "applied") onEffect();
					return reply;
				},
			},
			executor: "hand",
			pipeline: agentPreparationPipeline(session.agent),
		});
	let executor = build(open());
	return {
		prepare: (id, name, args, signal) => {
			const call: AgentToolCall = { type: "toolCall", id, name, arguments: args };
			return executor.prepare({
				issuer: ISSUER,
				generation: 1,
				workspace: session.sessionManager.getCwd(),
				scope: "scope",
				call,
				assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
				context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
				admittedAt: ADMITTED_AT,
				leaseUntil: ADMITTED_AT + 3_600_000,
				...(signal === undefined ? {} : { signal }),
			});
		},
		release: (id) =>
			executor.release({ key: { issuer: ISSUER, commandId: id }, generation: 1, actor: { id: ISSUER } }),
		row: (id) => open().read({ issuer: ISSUER, commandId: id }),
		restart: async () => {
			const recovered = open();
			await recovered.recover(Date.now());
			executor = build(recovered);
		},
	};
}

export function resultText(result: AgentToolResult<unknown>): string {
	return (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}
