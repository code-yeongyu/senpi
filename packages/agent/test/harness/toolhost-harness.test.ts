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

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("harness tool calls on the ToolHost", () => {
	it("runs a model-issued tool body on the prepared pipeline and records its witness", async () => {
		const bodyValues: string[] = [];
		const echo: AgentHarnessTool<undefined, typeof parameters, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo input",
			parameters,
			async execute(_toolCallId, args) {
				bodyValues.push(args.value);
				return { content: [{ type: "text", text: args.value }], details: { value: args.value } };
			},
		};
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
				tools: [echo],
				activeToolNames: ["echo"],
				onExecutionPipeline: (witness) => {
					witnesses.push(witness);
				},
			},
			BACKGROUND_CONTEXT,
		);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { value: "ran" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const result = await lane.prompt("go", undefined, BACKGROUND_CONTEXT);

		expect(result).toMatchObject({ ok: true });
		expect(bodyValues).toEqual(["ran"]);
		expect(witnesses).toEqual([{ pipeline: "prepared", toolCallId: "call-1" }]);
	});

	// #5859 review: a tool call the model stream flagged incomplete (with an errorMessage) that the harness still cleared
	// must reach its body like any other call; the prepared host refused it before the body ran and the lane faulted.
	it("runs the body of a cleared call that carries the stream's incomplete flag", async () => {
		const bodyValues: string[] = [];
		const echo: AgentHarnessTool<undefined, typeof parameters, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo input",
			parameters,
			async execute(_toolCallId, args) {
				bodyValues.push(args.value);
				return { content: [{ type: "text", text: args.value }], details: { value: args.value } };
			},
		};
		const session = new StorageBackedSession(
			{ id: "toolhost-harness-incomplete", createdAt: 1, storageVersion: 1 },
			new MemoryStorage(),
		);
		sessions.push(session);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await AgentHarness.create(
			{ session, models, model: faux.getModel(), tools: [echo], activeToolNames: ["echo"] },
			BACKGROUND_CONTEXT,
		);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const call = {
			...fauxToolCall("echo", { value: "ran" }, { id: "call-1" }),
			incomplete: true as const,
			errorMessage: "stream ended",
		};
		faux.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);

		const result = await lane.prompt("go", undefined, BACKGROUND_CONTEXT);

		expect(result).toMatchObject({ ok: true });
		expect(bodyValues).toEqual(["ran"]);
	});
});
