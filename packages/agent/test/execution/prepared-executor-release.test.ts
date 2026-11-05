import type { AgentTool, AgentToolCall } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createExecutionLedger } from "../../src/execution/ledger.ts";
import { createPreparedExecutor } from "../../src/execution/prepared/executor.ts";
import type { PreparationPipeline } from "../../src/execution/prepared/executor-types.ts";

// Release authority, abort, name correction and admission identity on the prepared executor, over a fake pipeline.
const ISSUER = "brain";
const NOW = Date.now();

async function open() {
	const runs: string[] = [];
	const frozenPairs: Array<[unknown, unknown]> = [];
	const echo: AgentTool = {
		name: "echo",
		label: "echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			runs.push(text);
			return { content: [{ type: "text", text: `tool:${text}` }], details: {} };
		},
	};
	const pipeline: PreparationPipeline = {
		resolve: async (call) => {
			if (call.name === "boom") throw new Error("resolver failed");
			return call.name.toLowerCase() === "echo" ? echo : undefined;
		},
		beforeToolCall: async (context) =>
			(context.args as { text?: unknown }).text === "block" ? { block: true, reason: "blocked" } : undefined,
		afterToolCall: async () => undefined,
		removedToolHint: () => undefined,
		afterFreeze: (prepared, frozen) => {
			frozenPairs.push([prepared, frozen]);
		},
	};
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const ledger = createExecutionLedger({ store: openMemoryStore(medium), epoch: 1, admission: createAdmissionLine() });
	const executor = createPreparedExecutor({ ledger, executor: "hand", pipeline });
	const prepare = (call: Partial<AgentToolCall> & { id: string; name: string; arguments: JsonObject }) => {
		const toolCall: AgentToolCall = { type: "toolCall", ...call };
		return executor.prepare({
			issuer: ISSUER,
			generation: 1,
			workspace: "workspace",
			scope: "scope",
			call: toolCall,
			assistantMessage: fauxAssistantMessage([toolCall], { stopReason: "toolUse" }),
			context: { messages: [], tools: [echo] },
			admittedAt: NOW,
			leaseUntil: NOW + 3_600_000,
		});
	};
	const release = (id: string, options: { actor?: string; generation?: number; signal?: AbortSignal } = {}) =>
		executor.release({
			key: { issuer: ISSUER, commandId: id },
			generation: options.generation ?? 1,
			actor: { id: options.actor ?? ISSUER },
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	return { prepare, release, runs, ledger, frozenPairs };
}

describe("prepared executor release and admission edges", () => {
	it("refuses a wrong actor or an old generation without blocking the issuer's own release", async () => {
		// Given
		const { prepare, release, runs } = await open();
		await prepare({ id: "auth", name: "echo", arguments: { text: "hi" } });

		// When
		const stranger = await release("auth", { actor: "someone-else" });
		const stale = await release("auth", { generation: 2 });
		const own = await release("auth");
		const strangerAfter = await release("auth", { actor: "someone-else" });

		// Then
		expect(stranger).toEqual({ kind: "refused", reason: "unauthorized" });
		expect(stale).toEqual({ kind: "refused", reason: "stale_generation" });
		expect(own.kind).toBe("settled");
		expect(strangerAfter).toEqual({ kind: "refused", reason: "unauthorized" });
		expect(runs).toEqual(["hi"]);
	});

	it("never starts the body for a release whose signal is already aborted", async () => {
		// Given
		const { prepare, release, runs, ledger } = await open();
		await prepare({ id: "aborted", name: "echo", arguments: { text: "hi" } });
		const abort = new AbortController();
		abort.abort();

		// When
		const reply = await release("aborted", { signal: abort.signal });

		// Then
		expect(reply.kind).toBe("aborted");
		expect(runs).toEqual([]);
		expect((await ledger.read({ issuer: ISSUER, commandId: "aborted" }))?.bodyDispatched).toBe(false);
	});

	it("carries the model's own name to the settled reply and the durable result", async () => {
		// Given
		const { prepare, release, ledger } = await open();
		const prepared = await prepare({ id: "alias", name: "Echo", arguments: { text: "hi" } });

		// When
		const released = await release("alias");

		// Then
		expect(prepared).toMatchObject({ kind: "prepared", requestedName: "Echo" });
		expect(released).toMatchObject({ kind: "settled", requestedName: "Echo" });
		const row = await ledger.read({ issuer: ISSUER, commandId: "alias" });
		expect(row?.progress.state === "settled" && row.progress.outcome).toMatchObject({
			reason: "result",
			value: { requestedName: "Echo" },
		});
	});

	it("turns a throwing resolver into a durable blocked reply that a re-sent prepare gets back", async () => {
		// Given
		const { prepare } = await open();

		// When
		const first = await prepare({ id: "boom", name: "boom", arguments: {} });
		const resent = await prepare({ id: "boom", name: "boom", arguments: {} });

		// Then
		expect(first.kind).toBe("blocked");
		expect(resent).toEqual(first);
	});

	it("binds an incomplete call's identity apart from a complete call with the same id, name and arguments", async () => {
		// Given
		const { prepare } = await open();
		await prepare({ id: "cut", name: "echo", arguments: { text: "hi" }, incomplete: true });

		// When
		const complete = await prepare({ id: "cut", name: "echo", arguments: { text: "hi" } });

		// Then
		expect(complete).toEqual({ kind: "refused", reason: "identity_conflict" });
	});

	// senpi#5795: preflight facts move from the prepared arguments object to the frozen copy exactly once per frozen call.
	it("hands afterFreeze the prepared and frozen arguments once per frozen call, never for a blocked one", async () => {
		// Given
		const { prepare, release, runs, frozenPairs } = await open();

		// When
		await prepare({ id: "ran", name: "echo", arguments: { text: "hi" } });
		await prepare({ id: "blocked", name: "echo", arguments: { text: "block" } });
		await release("ran");

		// Then
		expect(frozenPairs).toHaveLength(1);
		const [prepared, frozen] = frozenPairs[0] ?? [];
		expect(frozen).toEqual({ text: "hi" });
		expect(prepared).toEqual(frozen);
		expect(prepared).not.toBe(frozen);
		expect(runs).toEqual(["hi"]);
	});
});
