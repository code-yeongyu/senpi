/**
 * senpi#6752: who may run `machine_op` and how often it runs. The four records stay outside `RPC_METHOD_CLASS` (so the
 * digest forwarders pin is unchanged) and are answered only on a launch-proven connection that declared no delegation;
 * an answer is cached by `op_id`, so a repeat (or one arriving while the first still runs) never runs the op again.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../../src/config.ts";
import { RPC_METHOD_CLASS } from "../../src/modes/rpc/method-classes.ts";
import { type DelegatedHost, declare, type Peer, startHost } from "./rpc-delegated-host-support.ts";
import { answered, base64, machineOpRecord, notAuthorized, outcome, runOp } from "./rpc-machine-op-support.ts";

const COMMANDS = ["machine_op", "machine_op_result", "machine_op_owner", "machine_op_health"] as const;
const ALL_GRANTS = ["observe", "drive", "answer", "thread", "device_admin"];

let host: DelegatedHost;
let peer: Peer;
let root: string;

beforeAll(async () => {
	host = await startHost();
	peer = await host.proven();
	root = join(host.scratch, "work");
	await mkdir(root);
});
afterAll(async () => {
	await host.dispose();
});

describe("senpi#6752: machine_op admission and the op_id answer cache", () => {
	it("reports a fresh engine's health and keeps the four records out of the method-class table", async () => {
		expect(await peer.send({ type: "machine_op_health" })).toEqual(
			answered("machine_op_health", { ok: true, terminals: 0, cache: 0, version: VERSION }),
		);
		for (const command of COMMANDS) expect(Object.hasOwn(RPC_METHOD_CLASS, command), command).toBe(false);
	});

	it("refuses every record on a delegated or unproven connection and runs nothing", async () => {
		const delegated = await host.proven();
		expect(await declare(delegated, ALL_GRANTS)).toMatchObject({ success: true });
		const keyless = await host.keyless();
		const marker = join(root, "marker.txt");
		for (const asker of [delegated, keyless]) {
			expect(await asker.send(machineOpRecord("fs.write", { path: marker, bytes: base64("x") }, { root }))).toEqual(
				notAuthorized("machine_op"),
			);
			expect(await asker.send({ type: "machine_op_result", op_id: "any" })).toEqual(
				notAuthorized("machine_op_result"),
			);
			expect(await asker.send({ type: "machine_op_owner", handle_id: "any" })).toEqual(
				notAuthorized("machine_op_owner"),
			);
			expect(await asker.send({ type: "machine_op_health" })).toEqual(notAuthorized("machine_op_health"));
		}
		expect(existsSync(marker)).toBe(false);
	});

	it("answers a repeated op_id from the cache without running it again", async () => {
		const counter = join(root, "counter.txt");
		const record = machineOpRecord("shell", { command: `printf x >> ${counter}` }, { root });
		const first = await peer.send(record);
		expect(first).toEqual(
			outcome({
				state: "applied",
				response: {
					exitCode: 0,
					signal: null,
					stdout: "",
					stderr: "",
					timedOut: false,
					durationMs: expect.any(Number),
					truncated: false,
				},
			}),
		);
		expect(await peer.send(record)).toEqual({ ...first, id: expect.any(String) });
		expect(await readFile(counter, "utf8")).toBe("x");
		expect(await peer.send({ type: "machine_op_result", op_id: record.op_id })).toEqual(
			answered("machine_op_result", { known: true, outcome: first.data }),
		);
		expect(await peer.send({ type: "machine_op_result", op_id: "never-sent" })).toEqual(
			answered("machine_op_result", { known: false }),
		);
	});

	it("joins a repeat that arrives while the first run is still going", async () => {
		const counter = join(root, "joined.txt");
		const record = machineOpRecord("shell", { command: `sleep 0.3; printf y >> ${counter}` }, { root });
		const [first, second] = await Promise.all(peer.sendTogether([record, record]));
		expect(first?.data).toEqual(second?.data);
		expect(await readFile(counter, "utf8")).toBe("y");
	});

	it("answers an unknown handle's owner as unknown", async () => {
		expect(await peer.send({ type: "machine_op_owner", handle_id: "missing" })).toEqual(
			answered("machine_op_owner", {}),
		);
		expect(await runOp(peer, "process.info", { handleId: "missing" }, { root })).toEqual(
			outcome({ state: "failed", error: { code: "process_not_found", message: "no handle missing" } }),
		);
	});
});
