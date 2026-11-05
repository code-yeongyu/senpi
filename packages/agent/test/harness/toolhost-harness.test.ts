import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionPipelineWitness } from "../../src/execution/tool-host.ts";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import type { Session } from "../../src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../src/harness/types.ts";

const sessions: Session[] = [];
const parameters = Type.Object({ value: Type.String() });
type Tool = AgentHarnessTool<undefined, typeof parameters, unknown>;

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

// One model-issued call to `tool` with `{ value: "ran" }`, then a final answer.
async function promptOnce(tool: Tool, onHarness: (harness: AgentHarness) => void = () => {}) {
	const session = new StorageBackedSession(
		{ id: "toolhost-harness", createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const witnesses: ExecutionPipelineWitness[] = [];
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			tools: [tool],
			activeToolNames: [tool.name],
			onExecutionPipeline: (witness) => {
				witnesses.push(witness);
			},
		},
		BACKGROUND_CONTEXT,
	);
	onHarness(harness);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(tool.name, { value: "ran" }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const result = await lane.prompt("go", undefined, BACKGROUND_CONTEXT);
	return { result, witnesses };
}

function probe(execute: Tool["execute"], prepareArguments?: Tool["prepareArguments"]): Tool {
	return {
		name: "probe",
		label: "Probe",
		description: "Probe input",
		parameters,
		...(prepareArguments === undefined ? {} : { prepareArguments }),
		execute,
	};
}

const ran = { content: [{ type: "text" as const, text: "ran" }], details: undefined };

describe("harness tool calls on the ToolHost", () => {
	it("runs a model-issued tool body on the prepared pipeline and records its witness", async () => {
		const bodyValues: string[] = [];

		const { result, witnesses } = await promptOnce(
			probe(async (_toolCallId, args) => {
				bodyValues.push(args.value);
				return ran;
			}),
		);

		expect(result).toMatchObject({ ok: true });
		expect(bodyValues).toEqual(["ran"]);
		expect(witnesses).toEqual([{ pipeline: "prepared", toolCallId: "call-1" }]);
	});

	// senpi#5861: the host records a JSON copy; the body and after_tool share the cleared arguments object itself.
	it("hands after_tool the arguments the body edited in place", async () => {
		const seen: unknown[] = [];

		await promptOnce(
			probe(async (_toolCallId, args) => {
				args.value = "edited";
				return ran;
			}),
			(harness) => {
				harness.hooks.on("after_tool", ({ args }) => {
					seen.push(args.value);
					return undefined;
				});
			},
		);

		expect(seen).toEqual(["edited"]);
	});

	it("runs the body with a value prepareArguments added that JSON would turn into a string", async () => {
		const received: unknown[] = [];

		await promptOnce(
			probe(
				async (_toolCallId, args) => {
					received.push((args as Record<string, unknown>).at);
					return ran;
				},
				(raw) => ({ ...(raw as object), at: new Date(0) }) as never,
			),
		);

		expect(received).toHaveLength(1);
		expect(received[0]).toBeInstanceOf(Date);
	});

	it("settles arguments JSON cannot carry as a tool error before the body runs", async () => {
		const bodyRuns: string[] = [];
		const after: Array<{ isError: boolean; text: string }> = [];

		const { result } = await promptOnce(
			probe(
				async (_toolCallId, args) => {
					bodyRuns.push(args.value);
					return ran;
				},
				(raw) => ({ ...(raw as object), size: 1n }) as never,
			),
			(harness) => {
				harness.hooks.on("after_tool", ({ isError, content }) => {
					after.push({ isError, text: content[0]?.type === "text" ? content[0].text : "" });
					return undefined;
				});
			},
		);

		expect(result).toMatchObject({ ok: true });
		expect(bodyRuns).toEqual([]);
		expect(after).toEqual([{ isError: true, text: expect.stringMatching(/^Tool arguments are not JSON: /) }]);
	});
});
