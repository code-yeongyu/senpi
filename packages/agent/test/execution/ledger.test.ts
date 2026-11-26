// senpi#4997: endpoint ordering and recovery must hold on the portable DurableStore contract.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createExecutionLedger } from "../../src/execution/ledger.ts";

const admission = {
	issuer: "brain",
	commandId: "call-1",
	executor: "hand",
	workspace: "workspace",
	scope: "scope",
	generation: 1,
	requestDigest: "raw-digest",
	admittedAt: 100,
	leaseUntil: 60_100,
	reconcilable: false,
} as const;

async function fixture() {
	const medium = createMemoryStoreMedium();
	const store = openMemoryStore(medium);
	await store.claim(0, 1);
	const ledger = createExecutionLedger({ store, epoch: 1, admission: createAdmissionLine() });
	return { medium, store, ledger };
}

describe("the execution ledger", () => {
	it("admits an identity once, refuses a conflicting binding, and never re-dispatches a replay", async () => {
		const { ledger } = await fixture();
		const first = await ledger.admit(admission);
		expect(first.status).toBe("applied");
		expect((await ledger.admit(admission)).status).toBe("replayed");
		expect(await ledger.admit({ ...admission, scope: "another" })).toEqual({
			status: "refused",
			reason: "identity_conflict",
		});
		const command = { key: admission, generation: 1, actor: { id: "hand" }, now: 101 };
		await ledger.apply({ ...command, event: { kind: "prepare" } });
		await ledger.apply({ ...command, event: { kind: "effect" } });
		await ledger.apply({
			...command,
			event: {
				kind: "freeze",
				call: { name: "read", args: { path: "a" }, digest: "frozen" },
				awaitingConsent: false,
			},
		});
		await ledger.apply({ ...command, actor: { id: "brain" }, event: { kind: "release" } });
		expect((await ledger.apply({ ...command, event: { kind: "dispatch" } })).status).toBe("applied");
		expect((await ledger.apply({ ...command, event: { kind: "dispatch" } })).status).toBe("replayed");
	});

	it("keeps cancel-first terminal across a late result and a restart", async () => {
		const { ledger, medium } = await fixture();
		await ledger.admit(admission);
		const command = { key: admission, generation: 1, actor: { id: "hand" }, now: 101 };
		await ledger.apply({ ...command, event: { kind: "prepare" } });
		await ledger.apply({ ...command, event: { kind: "effect" } });
		await ledger.apply({ ...command, actor: { id: "brain" }, event: { kind: "cancel" } });
		await ledger.apply({ ...command, event: { kind: "result", value: "late" } });
		const reopened = createExecutionLedger({
			store: openMemoryStore(medium),
			epoch: 1,
			admission: createAdmissionLine(),
		});
		await reopened.recover(102);
		expect((await reopened.read(admission))?.progress).toEqual({
			state: "settled",
			outcome: { reason: "cancelled", hooksRan: true, uncertain: true },
		});
	});
});
