// senpi#5728 (S36, plan amendment A4): the loop core names only the batch-store factory type and builds no store
// (senpi#4996). The package entry supplies a fresh in-memory store per batch, so an external caller needs no new
// argument; a caller of the core alone gets a typed refusal instead of a silent non-durable default.
import {
	Agent,
	BatchStoreMissingError,
	type ExecutionPipelineWitness,
	agentLoop,
	agentLoopContinue,
	openMemoryBatchStore,
	runAgentLoop,
	runAgentLoopContinue,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { Agent as LoopCoreAgent } from "../../src/agent.ts";
import { call, echo, model, reply } from "./prepared-parity-fixture.ts";

const turns = (...batches: (readonly ReturnType<typeof call>[])[]) => {
	let index = 0;
	return () => reply(index < batches.length ? [...(batches[index++] ?? [])] : [{ type: "text", text: "done" }]);
};

describe("the package entry, called as an external consumer", () => {
	it("runs Agent on the prepared pipeline with no factory argument", async () => {
		const witnesses: ExecutionPipelineWitness[] = [];
		const agent = new Agent({
			initialState: { model, tools: [echo] },
			streamFn: turns([call("c0", "echo", { n: 0 })]),
			onExecutionPipeline: (witness) => {
				witnesses.push(witness);
			},
		});
		await agent.prompt("go");
		expect(witnesses).toEqual([{ pipeline: "prepared", toolCallId: "c0" }]);
		expect(agent.state.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
	});

	const witnessingConfig = (witnesses: ExecutionPipelineWitness[]) => ({
		model,
		convertToLlm: (messages: readonly { readonly role: string }[]) =>
			messages.filter((m) => m.role !== "custom") as never,
		onExecutionPipeline: (witness: ExecutionPipelineWitness) => {
			witnesses.push(witness);
		},
	});
	const prompt = () => [{ role: "user" as const, content: "go", timestamp: 1 }];
	const withPrompt = () => ({ systemPrompt: "", messages: prompt(), tools: [echo] });
	const empty = () => ({ systemPrompt: "", messages: [], tools: [echo] });
	const drain = async (stream: AsyncIterable<unknown> & { result(): Promise<unknown> }) => {
		for await (const _event of stream);
		await stream.result();
	};
	const loops: readonly [string, (witnesses: ExecutionPipelineWitness[]) => Promise<unknown>][] = [
		[
			"agentLoop",
			(w) => drain(agentLoop(prompt(), empty(), witnessingConfig(w), undefined, turns([call("c0", "echo")]))),
		],
		[
			"agentLoopContinue",
			(w) => drain(agentLoopContinue(withPrompt(), witnessingConfig(w), undefined, turns([call("c0", "echo")]))),
		],
		[
			"runAgentLoop",
			(w) =>
				runAgentLoop(
					prompt(),
					empty(),
					witnessingConfig(w),
					() => undefined,
					undefined,
					turns([call("c0", "echo")]),
				),
		],
		[
			"runAgentLoopContinue",
			(w) =>
				runAgentLoopContinue(
					withPrompt(),
					witnessingConfig(w),
					() => undefined,
					undefined,
					turns([call("c0", "echo")]),
				),
		],
	];

	it.each(loops)("runs %s on the prepared pipeline with no factory argument", async (_name, run) => {
		const witnesses: ExecutionPipelineWitness[] = [];
		await run(witnesses);
		expect(witnesses).toEqual([{ pipeline: "prepared", toolCallId: "c0" }]);
	});
});

describe("the loop core alone", () => {
	it("refuses a tool batch with BatchStoreMissingError when no factory is configured", async () => {
		const agent = new LoopCoreAgent({
			initialState: { model, tools: [echo] },
			streamFn: turns([call("c0", "echo")]),
		});
		await agent.prompt("go").catch(() => undefined);
		const failed = agent.state.messages.find((m) => m.role === "assistant" && m.errorMessage !== undefined);
		expect(failed?.role === "assistant" ? failed.errorMessage : undefined).toBe(new BatchStoreMissingError().message);
		expect(agent.state.messages.some((m) => m.role === "toolResult")).toBe(false);
	});
});

it("opens a fresh store for every batch, never the previous batch's", async () => {
	const opened: unknown[] = [];
	const agent = new LoopCoreAgent({
		initialState: { model, tools: [echo] },
		streamFn: turns([call("same-id", "echo", { n: 0 })], [call("same-id", "echo", { n: 1 })]),
		batchStoreFactory: () => {
			const store = openMemoryBatchStore();
			opened.push(store);
			return store;
		},
	});
	await agent.prompt("go");
	expect(opened).toHaveLength(2);
	expect(opened[0]).not.toBe(opened[1]);
	expect(agent.state.messages.filter((m) => m.role === "toolResult").map((m) => m.isError)).toEqual([false, false]);
});
