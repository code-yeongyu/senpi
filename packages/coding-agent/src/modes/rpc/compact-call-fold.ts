import type { ActiveBlock } from "./compact-active-block.ts";
import type { CallCorrelation, CallProjection, CallRaw, CallScope } from "./compact-call-model.ts";
import type { CallStep, CompactSessionCalls } from "./compact-session-calls.ts";
import type { SeededMessage } from "./compact-seeded-messages.ts";
import type { CompactTransition } from "./compact-transition.ts";

export interface CallFold {
	readonly changed: boolean;
	readonly projection?: CallProjection;
}

type SeededBlockTransition = Extract<CompactTransition, { type: "seeded_block" }>;

const field = (record: object, key: string): unknown => Reflect.get(record, key);
const text = (record: object, key: string): string => String(field(record, key) ?? "");
const ownedRaw = (block: ActiveBlock | undefined): CallRaw | null =>
	block ? { kind: "owned", root: block.root, tailRoot: block.tailRoot } : null;

/** The announcement side: the seeded block records and the terminal message of one assistant stream. */
export function foldCallBlock(
	calls: CompactSessionCalls,
	t: SeededBlockTransition,
	step: CallStep,
	block: ActiveBlock | undefined,
): void {
	const address = { messageId: t.messageId, contentIndex: t.event.contentIndex };
	const correlation: CallCorrelation | undefined = t.correlation && {
		...("clientMessageId" in t.correlation ? { clientMessageId: field(t.correlation, "clientMessageId") } : {}),
		...("clientTurnId" in t.correlation ? { clientTurnId: field(t.correlation, "clientTurnId") } : {}),
	};
	switch (t.event.type) {
		case "toolcall_start":
			return calls.toolStart(step, {
				...address,
				id: t.event.id,
				name: t.event.toolName,
				arguments: t.event.seed.block.arguments,
				...(t.resolvedToolName === undefined ? {} : { resolvedName: t.resolvedToolName }),
				...(correlation ? { correlation } : {}),
			});
		case "toolcall_end":
			return calls.announce(
				step,
				{
					...address,
					id: t.event.toolCall.id,
					name: t.event.toolCall.name,
					arguments: t.event.toolCall.arguments,
					...(t.resolvedToolName === undefined ? {} : { resolvedName: t.resolvedToolName }),
				},
				ownedRaw(block),
			);
		case "message_block_metadata":
			if (t.event.name !== undefined)
				calls.requestedName(step, address.messageId, address.contentIndex, t.event.name);
			return;
		default:
			return;
	}
}

/** The terminal payload is authoritative for every toolCall block; a block no event announced gets its call here. */
export function foldCallTerminal(
	calls: CompactSessionCalls,
	messageId: string,
	message: SeededMessage,
	step: CallStep,
	live: ReadonlyMap<number, ActiveBlock> | undefined,
): void {
	if (message.role !== "assistant") return;
	for (const [contentIndex, block] of message.content.entries())
		if (block.type === "toolCall")
			calls.announce(
				step,
				{ messageId, contentIndex, id: block.id, name: block.name, arguments: block.arguments },
				ownedRaw(live?.get(contentIndex)),
			);
}

/** The execution side: a JSON-normal legacy record folded at one lane step (RULING-13 Q9 reports `changed`). */
export function foldCallRecord(
	calls: CompactSessionCalls,
	record: object,
	scope: CallScope,
	sequence: number,
): CallFold {
	const step = { sequence, scope };
	const before = calls.table.counters.replacements;
	let projection: CallProjection | undefined;
	switch (field(record, "type")) {
		case "tool_execution_start": {
			const parentToolCallId = field(record, "parentToolCallId");
			calls.executionStart(step, {
				toolCallId: text(record, "toolCallId"),
				toolName: text(record, "toolName"),
				args: field(record, "args") ?? null,
				...(typeof parentToolCallId === "string" ? { parentToolCallId } : {}),
			});
			break;
		}
		case "tool_execution_update":
			calls.executionUpdate(
				step,
				text(record, "toolCallId"),
				field(record, "args") ?? null,
				field(record, "partialResult") ?? null,
			);
			break;
		case "tool_execution_end":
			calls.executionEnd(
				step,
				text(record, "toolCallId"),
				field(record, "result") ?? null,
				field(record, "isError") === true,
			);
			break;
		case "tool_hook_status":
			calls.hook(step, text(record, "toolCallId"), record);
			break;
		case "turn_end":
			calls.turnEnd(step);
			break;
		case "agent_settled":
			calls.agentSettled(step);
			break;
		case "message_end": {
			const message = Object(field(record, "message"));
			if (field(message, "role") === "toolResult")
				projection = calls.settle(step, text(message, "toolCallId"), field(message, "isError") === true);
			break;
		}
	}
	return { changed: calls.table.counters.replacements !== before, ...(projection ? { projection } : {}) };
}
