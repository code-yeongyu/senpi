/**
 * omo-relay-daemon#307, claims and records: incarnation exhaustion closes the record (L4), the single stale predicate
 * `ConnectionRoles.declare` applies to every claim-creating path (E12), the record's socket lifetime (E10), the worker's
 * scalar incarnation resolution (W2), the credit answer `stale` (code 4) that refuses one declaration without ending
 * the worker (W4), and the v5-review H1 order: stale before the compact check.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CommandAuthority } from "../../src/modes/rpc/command-authority.ts";
import { createAuthority, readAuthority, storeRetired } from "../../src/modes/rpc/connection-authority.ts";
import { ConnectionRoles } from "../../src/modes/rpc/connection-roles.ts";
import { ConnectionDelegations } from "../../src/modes/rpc/delegated-connection.ts";
import type { DelegationDescriptor } from "../../src/modes/rpc/delegation-record.ts";
import { resolveDelegation } from "../../src/modes/rpc/delegation-resolve.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { createWorkerCredit } from "../../src/modes/rpc/session-worker-credit.ts";
import { acknowledgeGrant } from "../../src/modes/rpc/session-worker-signals.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";
import { workerCapabilities } from "../../src/modes/rpc/worker-client-capabilities.ts";

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

describe("L4: incarnation exhaustion closes the record", () => {
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
