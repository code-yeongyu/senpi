/**
 * omo-relay-daemon#307, mechanism level: the authority word (packing, monotone stores, epoch bound), incarnation
 * allocation and exhaustion, the single stale predicate `ConnectionRoles.declare` applies to every claim-creating path,
 * the record's socket lifetime, the worker's scalar incarnation resolution, the one snapshot per command, and the
 * credit answer `stale` (code 4) that refuses one declaration without ending the worker. The integrated behaviour is in
 * `rpc-delegated-roles.test.ts` (host scope) and `rpc-delegated-roles-worker.test.ts` (session workers).
 */
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { CommandAuthority } from "../../src/modes/rpc/command-authority.ts";
import {
	createAuthority,
	decodeWord,
	INCARNATION_MAX,
	incarnationOf,
	nextIncarnation,
	readAuthority,
	storeNarrowed,
	storeRetired,
} from "../../src/modes/rpc/connection-authority.ts";
import { ConnectionRoles } from "../../src/modes/rpc/connection-roles.ts";
import { ConnectionDelegations } from "../../src/modes/rpc/delegated-connection.ts";
import type { DelegationDescriptor } from "../../src/modes/rpc/delegation-record.ts";
import { resolveDelegation } from "../../src/modes/rpc/delegation-resolve.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { createWorkerCredit } from "../../src/modes/rpc/session-worker-credit.ts";
import { acknowledgeGrant } from "../../src/modes/rpc/session-worker-signals.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";
import { workerCapabilities } from "../../src/modes/rpc/worker-client-capabilities.ts";
import { awaitWord } from "./rpc-delegated-host-support.ts";

const IU = "interactive_user";
const TP = "task_parent";
const PRINCIPAL = { deviceId: "x307-device" };

function hostDelegations(options: ConstructorParameters<typeof ConnectionDelegations>[0] = {}) {
	const delegations = new ConnectionDelegations(options);
	delegations.admit("c", "proven");
	const declared = delegations.inspect("c", {
		type: "declare_delegation",
		principal: PRINCIPAL,
		granted: ["observe", "drive"],
		roles: [IU, TP],
	});
	expect(declared).toMatchObject({ kind: "reply", response: { success: true, data: { roles: [IU, TP] } } });
	const roles = new ConnectionRoles();
	roles.useDelegations((id) => delegations.viewOf(id));
	const detach = () => expect(delegations.inspect("c", { type: "detach_connection" })).toEqual({ kind: "pass" });
	return { delegations, roles, detach };
}

describe("W5: the authority word", () => {
	it("moves the epoch only on a real transition, stays monotone, and restarts at 1 per incarnation", () => {
		const buffer = createAuthority(1, 3);
		const epochs = [readAuthority(buffer).epoch];
		const stores = [
			() => storeNarrowed(buffer, [TP]),
			() => storeNarrowed(buffer, []),
			() => storeNarrowed(buffer, []),
			() => storeRetired(buffer),
			() => storeRetired(buffer),
		];
		const changed = stores.map((store) => {
			const moved = store();
			epochs.push(readAuthority(buffer).epoch);
			return moved;
		});
		expect(changed).toEqual([true, true, false, true, false]);
		expect(epochs).toEqual([1, 2, 3, 3, 4, 4]);
		expect(readAuthority(buffer)).toEqual({ epoch: 4, retired: true, mask: 0, roles: [] });
		expect(Atomics.load(new Int32Array(buffer), 0)).toBe(36);
		expect(decodeWord(36).epoch).toBe(4);
		expect(storeNarrowed(buffer, [IU, TP])).toBe(false);
		expect(readAuthority(createAuthority(2, 0)).epoch).toBe(1);
	});
});

describe("L4: incarnation allocation and exhaustion", () => {
	it("checks the successor before any stamp and never wraps", () => {
		expect(nextIncarnation(0x7ffffffe)).toBe(0x7fffffff);
		expect(nextIncarnation(INCARNATION_MAX)).toBeUndefined();
		expect(incarnationOf(createAuthority(INCARNATION_MAX, 3))).toBe(INCARNATION_MAX);
	});

	it("closes the record and ends the socket once, after the answer, when the counter runs out", () => {
		const endConnection = vi.fn<(id: string) => void>();
		const { delegations, detach } = hostDelegations({ incarnationMax: 3, endConnection });
		const first = delegations.recordOf("c")?.current?.authority;
		detach();
		expect(first && readAuthority(first).retired).toBe(true);
		detach();
		expect(delegations.recordOf("c")?.current?.incarnation).toBe(3);
		delegations.lineAnswered("c");
		expect(endConnection).not.toHaveBeenCalled();
		detach();
		const record = delegations.recordOf("c");
		expect(record?.closed).toBe(true);
		expect(record?.current?.incarnation).toBe(3);
		expect(record?.current && readAuthority(record.current.authority).retired).toBe(true);
		expect(endConnection).not.toHaveBeenCalled();
		delegations.lineAnswered("c");
		delegations.lineAnswered("c");
		expect(endConnection.mock.calls).toEqual([["c"]]);
	});
});

describe("E12: one stale predicate for every claim (v5 §3.6)", () => {
	it("lets only the current, open incarnation claim, and leaves untagged local declarations as they were", () => {
		const { delegations, roles, detach } = hostDelegations();
		expect(roles.declare("c", [IU], 1)).toBe("declared");
		expect(roles.declare("c", [IU], 1)).toBe("declared");
		expect(roles.declare("c", [], 1)).toBe("fixed");
		detach();
		expect(roles.isStale("c", 1)).toBe(true);
		expect(roles.declare("c", [IU], 1)).toBe("stale");
		expect(roles.declare("c", [IU], undefined)).toBe("stale");
		expect(roles.rolesOf("c", 2)).toBeUndefined();
		expect(roles.declare("c", [IU], 2)).toBe("declared");
		delegations.close("c");
		expect(roles.declare("c", [IU], 2)).toBe("stale");
		delegations.forget("c");
		expect(roles.declare("c", [IU], 2)).toBe("stale");
		expect(roles.declare("local", [IU], undefined)).toBe("declared");
		expect(roles.declare("local", [IU], 1)).toBe("stale");
	});

	it("treats a legacy-mode record like a local one: only an untagged declaration proceeds", () => {
		const delegations = new ConnectionDelegations();
		delegations.admit("legacy", "proven");
		delegations.inspect("legacy", { type: "declare_delegation", principal: PRINCIPAL, granted: ["drive"] });
		const roles = new ConnectionRoles();
		roles.useDelegations((id) => delegations.viewOf(id));
		expect(roles.declare("legacy", [IU], 1)).toBe("stale");
		expect(roles.declare("legacy", [IU])).toBe("declared");
		expect(roles.has("legacy", IU)).toBe(true);
	});
});

describe("E10: the record lives as long as the socket", () => {
	it("retires at physical close, survives a logical detach, and is deleted only by forget", () => {
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("c", socketSink(new PassThrough()), { launchProof: "proven" });
		writer.delegations.inspect("c", {
			type: "declare_delegation",
			principal: PRINCIPAL,
			granted: ["drive"],
			roles: [IU],
		});
		const roles = new ConnectionRoles();
		roles.useDelegations((id) => writer.delegations.viewOf(id));
		expect(roles.declare("c", [IU], 1)).toBe("declared");
		expect(roles.has("c", IU)).toBe(true);
		writer.delegations.inspect("c", { type: "detach_connection" });
		roles.release("c");
		expect(writer.delegations.recordOf("c")).toMatchObject({ mode: "host", current: { incarnation: 2 } });
		expect(roles.has("c", IU)).toBe(false);
		expect(roles.declare("c", [IU], 2)).toBe("declared");
		expect(roles.has("c", IU)).toBe(true);
		writer.unregisterConnection("c");
		expect(roles.has("c", IU)).toBe(false);
		const record = writer.delegations.recordOf("c");
		expect(record?.closed).toBe(true);
		expect(record?.current && readAuthority(record.current.authority).retired).toBe(true);
		writer.delegations.forget("c");
		roles.forget("c");
		expect(writer.delegations.recordOf("c")).toBeUndefined();
		expect(roles.rolesOf("c", 2)).toBeUndefined();
	});
});

describe("W2: a worker resolves incarnations by scalar, never by wrapper identity", () => {
	const descriptor = (incarnation: number, authority = createAuthority(incarnation, 3)): DelegationDescriptor => ({
		principal: PRINCIPAL,
		mode: "host",
		incarnation,
		authority,
	});

	it("keeps the first buffer for an incarnation and sees the host's later stores through every clone", () => {
		const wire = descriptor(1);
		const first = resolveDelegation(undefined, structuredClone(wire));
		expect(first.resolution.kind).toBe("use");
		const retained = first.retain;
		for (let clone = 0; clone < 3; clone++) {
			const again = resolveDelegation(retained, structuredClone(wire));
			expect(again.resolution).toEqual({ kind: "use", descriptor: retained });
		}
		storeRetired(wire.authority ?? new SharedArrayBuffer(8));
		expect(retained?.authority && readAuthority(retained.authority).retired).toBe(true);
	});

	it("refuses a stamp mismatch, a live retained word under a newer incarnation, and another principal", () => {
		const retained = descriptor(1);
		expect(resolveDelegation(retained, descriptor(1, createAuthority(8, 3))).resolution.kind).toBe("conflict");
		expect(resolveDelegation(retained, descriptor(2)).resolution.kind).toBe("conflict");
		expect(resolveDelegation(retained, { ...descriptor(1), principal: { deviceId: "other" } }).resolution.kind).toBe(
			"conflict",
		);
		storeRetired(retained.authority ?? new SharedArrayBuffer(8));
		const next = descriptor(2);
		expect(resolveDelegation(retained, next)).toEqual({
			resolution: { kind: "use", descriptor: next },
			retain: next,
		});
		expect(resolveDelegation(next, retained).resolution.kind).toBe("stale");
	});

	it("reads a stale command's roles as retired while the command itself runs", () => {
		const roles = new ConnectionRoles();
		const current = descriptor(2);
		roles.retain("c", current);
		roles.adopt("c", [IU], 2);
		const stale = new CommandAuthority("c", descriptor(1), undefined, true);
		expect(stale.has(IU, [IU])).toBe(false);
		expect(new CommandAuthority("c", current, undefined).has(IU, roles.rolesOf("c", 2))).toBe(true);
	});
});

describe("W3: one snapshot per command is its admission", () => {
	it("keeps a command admitted before the store, and refuses the next command", () => {
		const authority = createAuthority(1, 3);
		const descriptor: DelegationDescriptor = { principal: PRINCIPAL, mode: "host", incarnation: 1, authority };
		const admitted = new CommandAuthority("c", descriptor, 7);
		expect(admitted.has(IU, [IU])).toBe(true);
		storeRetired(authority);
		expect(admitted.has(IU, [IU])).toBe(true);
		expect(admitted.receipt()).toEqual({ exec: 7, incarnation: 1, epoch: 1, roles: [IU] });
		const later = new CommandAuthority("c", descriptor, 8);
		expect(later.has(IU, [IU])).toBe(false);
		expect(later.receipt()).toEqual({ exec: 8, incarnation: 1, epoch: 2, roles: [] });
		expect(new CommandAuthority("c", descriptor, 9).receipt()).toEqual({
			exec: 9,
			incarnation: 1,
			epoch: 2,
			roles: null,
		});
	});
});

describe("W4: the stale credit answer refuses one declaration and keeps the worker", () => {
	it("maps 4 to stale, 1 to declared, and keeps 2 fatal", () => {
		let answer: "granted" | "conflict" | "stale" = "stale";
		const fail = vi.fn((error: string): never => {
			throw new Error(error);
		});
		const credit = createWorkerCredit((message) => {
			if ("signal" in message && message.signal) acknowledgeGrant(message.signal, answer);
		}, fail);
		const declare = () =>
			credit.declareOnHost((signal) => ({ type: "capabilities", capabilities: [IU], incarnation: 1, signal }));
		expect(declare()).toBe("stale");
		answer = "granted";
		expect(declare()).toBe("declared");
		expect(fail).not.toHaveBeenCalled();
		answer = "conflict";
		expect(declare).toThrow("session_worker_capabilities_denied");
	});
});

const PROBE = `
import { workerData, parentPort } from "node:worker_threads";
const { readAuthority } = await import(workerData.module);
const gate = new Int32Array(workerData.gate);
for (let step = 1; step <= 2; step++) {
	Atomics.wait(gate, 0, step - 1);
	parentPort.postMessage(readAuthority(workerData.authority));
}
`;

describe("W1: a host store is visible to a worker that was already blocked before its role check", () => {
	it("reads the narrowed, then the retired word through the same shared buffer", async () => {
		const authority = createAuthority(1, 3);
		const gate = new SharedArrayBuffer(4);
		const module = new URL("../../src/modes/rpc/connection-authority.ts", import.meta.url).href;
		const worker = new Worker(PROBE, { eval: true, workerData: { authority, gate, module } });
		const seen: unknown[] = [];
		const reads = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		worker.on("message", (state) => {
			seen.push(state);
			reads[seen.length - 1]?.resolve();
		});
		worker.once("error", (error) => {
			for (const read of reads) read.reject(error);
		});
		const view = new Int32Array(authority);
		const gateView = new Int32Array(gate);
		storeNarrowed(authority, [TP]);
		await awaitWord(view, 0, (word) => decodeWord(word).epoch === 2);
		Atomics.store(gateView, 0, 1);
		Atomics.notify(gateView, 0);
		await reads[0]?.promise;
		storeRetired(authority);
		Atomics.store(gateView, 0, 2);
		Atomics.notify(gateView, 0);
		await reads[1]?.promise;
		await worker.terminate();
		expect(seen).toEqual([
			{ epoch: 2, retired: false, mask: 2, roles: [TP] },
			{ epoch: 3, retired: true, mask: 2, roles: [TP] },
		]);
		expect(fileURLToPath(module)).toMatch(/connection-authority\.ts$/);
	});
});

describe("v5 review H1: a stale worker declaration is answered before the compact check", () => {
	it("answers 4 with nothing declared or applied, keeps the newer selection, and leaves the current-incarnation paths as they were", () => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("c", socketSink(new PassThrough()), { launchProof: "proven" });
		writer.delegations.inspect("c", {
			type: "declare_delegation",
			principal: PRINCIPAL,
			granted: ["drive"],
			roles: [IU, TP],
		});
		const roles = new ConnectionRoles();
		roles.useDelegations((id) => writer.delegations.viewOf(id));
		const selection = writer.compactSelection("c");
		const older = [IU];
		const newer = [IU, "secret_input_v1"];
		// A session-scoped declaration of `older` on incarnation 1, then a detach, then a host-level one of `newer` on 2.
		expect(selection?.declare(older, false, (caps) => roles.declare("c", caps, 1) === "declared")).toBeUndefined();
		writer.delegations.inspect("c", { type: "detach_connection" });
		roles.release("c");
		expect(selection?.declare(newer, false, (caps) => roles.declare("c", caps, 2) === "declared")).toBeUndefined();
		const applied = vi.fn<(connection: string | undefined, capabilities: readonly string[]) => void>();
		const options = { connectionRoles: roles, clientInfo: { connectionId: () => "c", setCapabilities: applied } };
		const answer = (capabilities: readonly string[], incarnation: number) => {
			const signal = new SharedArrayBuffer(4);
			workerCapabilities(
				options,
				{ type: "capabilities", connection: "c", capabilities, incarnation, signal },
				writer,
			);
			return Atomics.load(new Int32Array(signal), 0);
		};
		expect(answer(older, 1)).toBe(4);
		expect(applied).not.toHaveBeenCalled();
		expect(selection?.capabilities).toEqual(newer);
		expect(selection?.refused).toBe(false);
		expect(roles.rolesOf("c", 1)).toBeUndefined();
		expect(answer(newer, 2)).toBe(1);
		expect(applied.mock.calls).toEqual([["c", newer]]);
		expect(answer(older, 2)).toBe(2);
		expect(applied).toHaveBeenCalledTimes(1);
		vi.unstubAllEnvs();
	});
});
