import type { AgentTool, AgentToolCall } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { createExecutionLedger } from "../../../agent/src/execution/ledger.ts";
import { consentFromPermissionPolicy } from "../../src/core/execution/consent.ts";
import { createPreparedExecutor } from "../../src/core/execution/executor.ts";
import { digestOf, toStoreValue } from "../../src/core/execution/executor-freeze.ts";
import type { PreparationPipeline } from "../../src/core/execution/executor-types.ts";

// senpi#5663 (S12): Gate B on the prepared executor, cross-machine only. The approver is whoever the issuer's endpoint
// authenticated (any RPC-authorized party, K2): the executor checks the issuer and the frozen digest, never a device.
const ISSUER = "brain";
const LEASE_MS = 60_000;

async function open(options: {
	readonly consent: boolean;
	readonly normalize?: boolean;
	readonly writeAction?: "ask" | "deny";
}) {
	let now = Date.now();
	const admittedAt = now;
	const runs: string[] = [];
	const hooks: string[] = [];
	const write: AgentTool = {
		name: "write",
		label: "write",
		description: "Write a file",
		parameters: Type.Object({ path: Type.String() }),
		prepareArguments: (args) =>
			options.normalize === true && typeof args === "object" && args !== null && "path" in args
				? { path: String(args.path).replace(/^\.\//, "") }
				: args,
		execute: async (_id, params) => {
			runs.push(JSON.stringify(params));
			return { content: [{ type: "text", text: "written" }], details: {} };
		},
	};
	const pipeline: PreparationPipeline = {
		resolve: async () => write,
		beforeToolCall: async ({ toolCall }) => {
			hooks.push(toolCall.id);
			return undefined;
		},
		afterToolCall: async () => undefined,
		removedToolHint: () => undefined,
	};
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const ledger = createExecutionLedger({ store: openMemoryStore(medium), epoch: 1, admission: createAdmissionLine() });
	const executor = createPreparedExecutor({
		ledger,
		executor: "hand",
		pipeline,
		clock: () => now,
		...(options.consent
			? {
					consent: consentFromPermissionPolicy(({ name }) =>
						name === "write" ? (options.writeAction ?? "ask") : "allow",
					),
				}
			: {}),
	});
	const key = (id: string) => ({ issuer: ISSUER, commandId: id });
	return {
		runs,
		hooks,
		advance: (ms: number) => {
			now += ms;
		},
		prepare: (id: string, args: JsonObject, authorizedDigest?: string) => {
			const call: AgentToolCall = { type: "toolCall", id, name: "write", arguments: args };
			return executor.prepare({
				issuer: ISSUER,
				generation: 1,
				workspace: "workspace",
				scope: "scope",
				call,
				assistantMessage: fauxAssistantMessage([call], { stopReason: "toolUse" }),
				context: { messages: [], tools: [write] },
				admittedAt,
				leaseUntil: admittedAt + LEASE_MS,
				...(authorizedDigest === undefined ? {} : { authorizedDigest }),
			});
		},
		consent: (id: string, frozenDigest: string, actor = ISSUER) =>
			executor.consent({ key: key(id), generation: 1, actor: { id: actor }, frozenDigest }),
		release: (id: string) => executor.release({ key: key(id), generation: 1, actor: { id: ISSUER } }),
		row: (id: string) => ledger.read(key(id)),
	};
}

describe("Gate B on the prepared executor (cross-machine only)", () => {
	it("a call that needs consent waits; the approval binds its frozen digest and release runs it without rerunning hooks", async () => {
		const x = await open({ consent: true });
		const prepared = await x.prepare("a", { path: "notes.md" });
		if (prepared.kind !== "prepared_awaiting_consent") throw new Error(`expected awaiting, got ${prepared.kind}`);
		expect((await x.release("a")).kind).toBe("refused");
		expect(x.runs).toEqual([]);
		expect(await x.consent("a", prepared.call.digest)).toEqual({ kind: "prepared" });
		expect((await x.release("a")).kind).toBe("settled");
		expect([x.hooks, x.runs]).toEqual([["a"], ['{"path":"notes.md"}']]);
	});

	it("an approval of another frozen call, or from someone who is not the issuer, is refused", async () => {
		const x = await open({ consent: true });
		const prepared = await x.prepare("a", { path: "notes.md" });
		if (prepared.kind !== "prepared_awaiting_consent") throw new Error(`expected awaiting, got ${prepared.kind}`);
		expect(await x.consent("a", "another-digest")).toEqual({ kind: "refused", reason: "frozen_digest_mismatch" });
		expect(await x.consent("a", prepared.call.digest, "hand")).toEqual({ kind: "refused", reason: "unauthorized" });
		expect((await x.row("a"))?.progress.state).toBe("prepared_awaiting_consent");
	});

	it("an approval after the lease ran out answers the terminal lease_expired row and the body never runs", async () => {
		const x = await open({ consent: true });
		const prepared = await x.prepare("a", { path: "notes.md" });
		if (prepared.kind !== "prepared_awaiting_consent") throw new Error(`expected awaiting, got ${prepared.kind}`);
		x.advance(LEASE_MS + 1);
		const late = await x.consent("a", prepared.call.digest);
		if (late.kind !== "replayed") throw new Error(`expected the terminal row, got ${late.kind}`);
		expect(late.entry.progress).toMatchObject({
			state: "settled",
			outcome: { reason: "lease_expired", uncertain: true },
		});
		expect(x.runs).toEqual([]);
	});

	it("a Gate A approval of the raw request covers an identical frozen call; a shim that changes it asks again", async () => {
		const requestDigest = (args: JsonObject) =>
			digestOf(toStoreValue({ name: "write", args, incomplete: undefined, errorMessage: undefined }));
		const same = await open({ consent: true, normalize: true });
		expect((await same.prepare("a", { path: "notes.md" }, requestDigest({ path: "notes.md" }))).kind).toBe(
			"prepared",
		);

		const shimmed = await open({ consent: true, normalize: true });
		const raw = { path: "./notes.md" };
		expect((await shimmed.prepare("b", raw, requestDigest(raw))).kind).toBe("prepared_awaiting_consent");

		const other = await open({ consent: true });
		expect((await other.prepare("c", { path: "notes.md" }, requestDigest({ path: "other.md" }))).kind).toBe(
			"prepared_awaiting_consent",
		);
	});

	it("a call the policy denies is not consent: it is prepared, and its own tool_call chain refuses it as today", async () => {
		const x = await open({ consent: true, writeAction: "deny" });
		expect((await x.prepare("a", { path: "notes.md" })).kind).toBe("prepared");
	});

	it("K3: an executor with no consent classifier (fused, split-local) never waits", async () => {
		const x = await open({ consent: false });
		expect((await x.prepare("a", { path: "notes.md" })).kind).toBe("prepared");
		expect((await x.release("a")).kind).toBe("settled");
	});
});
