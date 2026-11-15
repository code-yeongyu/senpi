/**
 * senpi#6752 review M3: `machine_op` work keeps the host from being idle. A live machine terminal (or an op in
 * flight) blocks both the idle handover and the empty-host exit, which would otherwise dispose the handler and kill
 * the relay host's terminals; once the terminal ends, both proceed. Delta review (round-1 M3 remainder): the idle
 * decision and the step that ends the host are one step for machine work, so from the moment a handover switches or the
 * host exits empty a new `machine_op` is refused `machine_op_unavailable` and runs nothing; a blocked handover admits
 * machine work again.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HandoverOutcome, IdleHandoverRequest } from "../../src/modes/rpc/host-idle-handover.ts";
import { type DelegatedHost, type Peer, startHost } from "./rpc-delegated-host-support.ts";
import { outcome, runOp } from "./rpc-machine-op-support.ts";

const REQUEST: IdleHandoverRequest = {
	operationId: "op-6752",
	ifInstanceId: "instance-6752",
	ifGeneration: 0,
	targetRuntimeBuildId: "sha256:new",
	launch: { command: "senpi", args: [] },
	hostArgs: [],
	env: {},
};

let host: DelegatedHost;
let peer: Peer;
let root: string;
let exitAllowed = false;
let exits = 0;
const exited = Promise.withResolvers<void>();
const performed = Promise.withResolvers<IdleHandoverRequest>();
let performStep = async (request: IdleHandoverRequest): Promise<HandoverOutcome> => {
	performed.resolve(request);
	return { ok: false, reason: "test_successor" };
};
const UNAVAILABLE = {
	id: expect.any(String),
	type: "response",
	command: "machine_op",
	success: false,
	error: "machine_op_unavailable: the engine is handing over or shutting down; retry the op",
	errorCode: "machine_op_unavailable",
};
// Every empty-exit check the router makes, so a test can wait for checks instead of for time.
let checks = 0;
const checkWaiters = new Set<{ readonly at: number; readonly resolve: () => void }>();
const afterChecks = (count: number): Promise<void> =>
	new Promise((resolve) => checkWaiters.add({ at: checks + count, resolve }));

beforeAll(async () => {
	host = await startHost({
		idle: {
			emptyExitMs: 40,
			canExitWhenEmpty: () => {
				checks += 1;
				for (const waiter of [...checkWaiters])
					if (checks >= waiter.at) {
						checkWaiters.delete(waiter);
						waiter.resolve();
					}
				return exitAllowed;
			},
			onEmptyExit: () => {
				exits += 1;
				exited.resolve();
			},
		},
		hooks: {
			handover: {
				identity: () => ({ instanceId: "instance-6752", generation: 0, runtimeBuildId: "sha256:old" }),
				perform: (request) => performStep(request),
				pollMs: 3_600_000,
			},
		},
	});
	peer = await host.proven();
	root = join(host.scratch, "work");
	await mkdir(root);
});
afterAll(async () => {
	await host.dispose();
});

async function liveTerminal(): Promise<unknown> {
	const answer = await runOp(peer, "exec_command", { command: "cat", yield_ms: 250 }, { root });
	return (answer.data as { response: { handleId: unknown } }).response.handleId;
}

describe("senpi#6752 review M3: machine work keeps the host from being idle", () => {
	it("holds an idle handover pending while a machine terminal lives, and performs it once the terminal ends", async () => {
		const handle_id = await liveTerminal();
		expect(await host.core.handover?.begin(REQUEST)).toMatchObject({ view: { state: "handover_pending" } });
		await runOp(peer, "kill_terminal", { handle_id }, { root });
		host.core.handover?.observe();
		expect(await performed.promise).toMatchObject({ operationId: "op-6752" });
	});

	it("refuses machine ops while a handover switches, runs nothing, and admits them again once it is blocked", async () => {
		const switching = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		performStep = async () => {
			switching.resolve();
			await release.promise;
			return { ok: false, reason: "test_successor" };
		};
		const begun = host.core.handover?.begin({ ...REQUEST, operationId: "op-6752-window" });
		await switching.promise;
		const marker = join(root, "window.txt");
		const write = { command: `printf x > ${marker}` };
		expect(await runOp(peer, "shell", write, { root })).toEqual(UNAVAILABLE);
		expect(existsSync(marker)).toBe(false);
		release.resolve();
		expect(await begun).toMatchObject({ view: { state: "handover_blocked" } });
		expect(await runOp(peer, "shell", write, { root })).toMatchObject(outcome({ state: "applied", response: {} }));
		expect(existsSync(marker)).toBe(true);
	});

	it("never exits empty while a machine terminal lives, exits once it ends, then refuses new machine ops", async () => {
		const handle_id = await liveTerminal();
		exitAllowed = true;
		// Five checks without an exit, or the exit itself (the router stops checking once it has exited).
		await Promise.race([afterChecks(5), exited.promise]);
		expect(exits).toBe(0);
		expect(await runOp(peer, "wait_for_command", { handle_id, yield_ms: 250 }, { root })).toMatchObject({
			data: { response: { state: "running" } },
		});
		await runOp(peer, "kill_terminal", { handle_id }, { root });
		await exited.promise;
		expect(exits).toBe(1);
		const marker = join(root, "after-exit.txt");
		expect(await runOp(peer, "shell", { command: `printf x > ${marker}` }, { root })).toEqual(UNAVAILABLE);
		expect(existsSync(marker)).toBe(false);
	});
});
