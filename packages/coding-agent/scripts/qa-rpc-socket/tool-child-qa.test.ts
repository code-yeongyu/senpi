/**
 * The senpi QA scenario driver (`tool-child-qa.mjs`) and its helpers: exit codes, the requires gate,
 * `--expect-failure`, `--inject`, the launch-log reader, the fixture-start watcher and the
 * fixture-cleanup helper. Hosts are injected; the helpers that touch the OS run against real files
 * and real processes.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { injectEnv, parseQaArgs } from "./lib/qa-args.mjs";
import { QaFailure } from "./lib/qa-failure.mjs";
import { cleanupDetachedFixture } from "./lib/qa-fixture-cleanup.mjs";
import { watchFixtureStart } from "./lib/qa-fixture-start.mjs";
import { startQaHost } from "./lib/qa-host.mjs";
import { checkLaunchLog, parseLaunchLog } from "./lib/qa-launch-log.mjs";
import { SCENARIOS, unmetRequirements } from "./lib/qa-scenarios.mjs";
import { HARNESS_RPC_COMMANDS } from "./lib/rpc-client.mjs";
import { runDriver } from "./tool-child-qa.mjs";

const scratch: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tcq-"));
	scratch.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeHost {
	started: { env: Record<string, string>; runtime: string | undefined }[];
	deps: Record<string, unknown>;
}

function fakeHost(scenarios: unknown[], capabilities: string[] = ["tool_runtime:in-process"]): FakeHost {
	const started: FakeHost["started"] = [];
	const deps = {
		registry: scenarios,
		startHost: async (options: { env: Record<string, string>; runtime: string | undefined }) => {
			started.push({ env: options.env, runtime: options.runtime });
			return {
				protocolInfo: { capabilities },
				rpc: { request: async () => ({ success: true }), subscribe: () => () => undefined, close: () => undefined },
				stop: async () => undefined,
			};
		},
	};
	return { started, deps };
}

function jsonl(out: string, scenario: string): Record<string, unknown>[] {
	return readFileSync(join(out, `${scenario}.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("driver exit codes and gates", () => {
	test("an unknown scenario exits 2 without starting a host", async () => {
		const host = fakeHost([]);
		expect(await runDriver(["--scenario", "nope", "--out", tempDir()], host.deps)).toBe(2);
		expect(host.started).toEqual([]);
	});

	test("an awaited record that never arrives exits non-zero with record_timeout", async () => {
		const out = tempDir();
		const scenario = {
			id: "t-wait",
			requires: [],
			run: (ctx: { awaitRecord: (p: unknown, o: unknown) => Promise<unknown> }) =>
				ctx.awaitRecord(() => true, { name: "never", deadlineMs: 25 }),
		};
		const code = await runDriver(["--scenario", "t-wait", "--out", out], fakeHost([scenario]).deps);
		expect(code).toBe(1);
		expect(jsonl(out, "t-wait")).toContainEqual(expect.objectContaining({ failure: "record_timeout" }));
	});

	test("unmet requires exit 3 with prerequisite_missing", async () => {
		const out = tempDir();
		const scenario = { id: "t-req", requires: [4], run: () => undefined };
		const code = await runDriver(["--runtime", "child", "--scenario", "t-req", "--out", out], fakeHost([scenario]).deps);
		expect(code).toBe(3);
		expect(jsonl(out, "t-req")).toContainEqual(expect.objectContaining({ failure: "prerequisite_missing" }));
	});

	test("every scenario a later todo implements is declared and refused today", () => {
		const later = SCENARIOS.filter((scenario: { requires: number[] }) => scenario.requires.length > 0);
		expect(later.map((scenario: { id: string }) => scenario.id)).toContain("4-launch-apis-ack-gated");
		const today = { capabilities: ["tool_runtime:child"] };
		for (const scenario of later) expect(unmetRequirements(scenario.requires, today)).not.toEqual([]);
		const met = unmetRequirements([4, 14], {
			capabilities: ["tool_runtime:child", "placement:launch-barrier", "entries-paging"],
		});
		expect(met).toEqual([]);
	});

	test("--expect-failure passes only on the recorded expected failure", async () => {
		const failing = { id: "t-x", requires: [], run: () => Promise.reject(new QaFailure("X", "boom")) };
		const out = tempDir();
		expect(await runDriver(["--scenario", "t-x", "--expect-failure", "X", "--out", out], fakeHost([failing]).deps)).toBe(0);
		expect(jsonl(out, "t-x")).toContainEqual({ expected_failure: "X", observed: true });
		const other = tempDir();
		expect(await runDriver(["--scenario", "t-x", "--expect-failure", "Y", "--out", other], fakeHost([failing]).deps)).toBe(1);
		expect(jsonl(other, "t-x")).toContainEqual(expect.objectContaining({ expected_failure: "Y", observed: false }));
		const passing = { id: "t-ok", requires: [], run: () => undefined };
		expect(await runDriver(["--scenario", "t-ok", "--expect-failure", "X", "--out", tempDir()], fakeHost([passing]).deps)).toBe(1);
	});

	test("--inject A,B:v sets both switches with v as B's value and reaches the host env", async () => {
		const parsed = parseQaArgs(["--scenario", "s", "--inject", "A,B:v", "--env", "K=V", "--out", "/o"]);
		expect(parsed.ok).toBe(true);
		expect(parsed.value.inject).toEqual([
			{ name: "A", value: "1" },
			{ name: "B", value: "v" },
		]);
		expect(injectEnv(parsed.value.inject)).toEqual({ SENPI_TOOL_CHILD_TEST_A: "1", SENPI_TOOL_CHILD_TEST_B: "v" });
		const host = fakeHost([{ id: "t-env", requires: [], run: () => undefined }]);
		await runDriver(["--scenario", "t-env", "--inject", "A,B:v", "--env", "K=V", "--out", tempDir()], host.deps);
		expect(host.started[0]?.env).toMatchObject({ SENPI_TOOL_CHILD_TEST_A: "1", SENPI_TOOL_CHILD_TEST_B: "v", K: "V" });
		expect(parseQaArgs(["--scenario", "s"]).ok).toBe(false);
	});

	test("host start uses ensureHost and connects once, with no retry loop", async () => {
		const calls: string[] = [];
		const host = await startQaHost(
			{ runtime: "in-process", env: {}, extension: undefined, scratch: tempDir() },
			{
				ensureHost: async () => {
					calls.push("ensureHost");
					return { pid: 1, socket: "/s", reused: false, release: () => calls.push("release") };
				},
				connect: async () => {
					calls.push("connect");
					return {
						request: async () => ({ success: true, data: { capabilities: ["tool_runtime:in-process"] } }),
						subscribe: () => () => undefined,
						close: () => undefined,
					};
				},
				stopHost: async () => undefined,
			},
		);
		expect(calls).toEqual(["ensureHost", "connect", "release"]);
		expect(host.protocolInfo.capabilities).toEqual(["tool_runtime:in-process"]);
	});

	test("the RPC helper uses only commands present in the RPC type modules", () => {
		const rpcTypes = new URL("../../src/modes/rpc/", import.meta.url);
		const source = readdirSync(rpcTypes)
			.filter((name) => name.endsWith("-types.ts"))
			.map((name) => readFileSync(new URL(name, rpcTypes), "utf8"))
			.join("\n");
		for (const command of HARNESS_RPC_COMMANDS) expect(source).toContain(`type: "${command}"`);
	});
});

describe("launch-log reader", () => {
	const ok = [
		{ type: "launch", launchId: "L1" },
		{ type: "slot_state", launchId: "L1", invocations: 0 },
		{ type: "launch_ack", launchId: "L1" },
		{ type: "slot_state", launchId: "L1", invocations: 1 },
		{ type: "launch_proof", launchId: "L1", ackTick: 3, invokeTick: 4 },
		{ type: "launch_done", launchId: "L1", exitCode: 0 },
	];
	const reasons = (records: unknown[]) => checkLaunchLog(records).failures.map((f: { reason: string }) => f.reason);

	test("accepts invocations reaching 1 before launch_proof is logged", () => {
		expect(checkLaunchLog(ok)).toEqual({ ok: true, failures: [] });
	});

	test("accepts a detached launch whose proof is logged after its command_started", () => {
		const detached = [
			{ type: "launch", launchId: "D", lifetime: "detached" },
			{ type: "launch_ack", launchId: "D" },
			{ type: "command_started", launchId: "D", breakaway: true },
			{ type: "launch_proof", launchId: "D", ackTick: 1, invokeTick: 2 },
		];
		expect(checkLaunchLog(detached).ok).toBe(true);
	});

	test("rejects invokeTick <= ackTick, a missing ackTick, invocations while held, and done before proof", () => {
		expect(reasons(ok.map((r) => (r.type === "launch_proof" ? { ...r, invokeTick: 3 } : r)))).toEqual([
			"proof_order_violation",
		]);
		expect(reasons(ok.map((r) => (r.type === "launch_proof" ? { ...r, ackTick: null } : r)))).toEqual([
			"proof_missing_ack",
		]);
		expect(reasons(ok.map((r, i) => (i === 1 ? { ...r, invocations: 1 } : r)))).toEqual(["invoked_while_held"]);
		const doneFirst = [ok[0], ok[2], ok[5], ok[4]];
		expect(reasons(doneFirst)).toEqual(["done_before_proof"]);
	});

	test("rejects an unproven job membership and parses jsonl", () => {
		const records = parseLaunchLog(
			`${ok.map((r) => JSON.stringify(r)).join("\n")}\n${JSON.stringify({ type: "job_membership", launchId: "L1", member: false })}\n`,
		);
		expect(reasons(records)).toEqual(["job_membership_unproven"]);
	});
});

describe("fixture-start watcher", () => {
	test("resolves on a marker created after registration", async () => {
		const dir = tempDir();
		const started = watchFixtureStart({ markerDir: dir, marker: "marker-L1", deadlineMs: 5_000 });
		writeFileSync(join(dir, "marker-L1"), "1 1");
		await expect(started).resolves.toEqual({ via: "marker" });
	});

	test("resolves on a command_started{breakaway:true} record in the launch log", async () => {
		const dir = tempDir();
		const log = join(dir, "launches.jsonl");
		writeFileSync(log, `${JSON.stringify({ type: "launch", launchId: "W" })}\n`);
		const started = watchFixtureStart({ markerDir: dir, marker: "marker-W", launchLog: log, launchId: "W", deadlineMs: 5_000 });
		appendFileSync(log, `${JSON.stringify({ type: "command_started", launchId: "W", breakaway: true })}\n`);
		await expect(started).resolves.toEqual({ via: "command_started" });
	});

	test("never resolves on absence and fails at its deadline with fixture_start_timeout", async () => {
		const dir = tempDir();
		const log = join(dir, "launches.jsonl");
		writeFileSync(log, "");
		const started = watchFixtureStart({ markerDir: dir, marker: "marker-N", launchLog: log, launchId: "N", deadlineMs: 50 });
		appendFileSync(log, `${JSON.stringify({ type: "command_started", launchId: "N", breakaway: false })}\n`);
		writeFileSync(join(dir, "other-marker"), "x");
		await expect(started).rejects.toMatchObject({ code: "fixture_start_timeout" });
	});
});

describe.skipIf(process.platform === "win32")("fixture-cleanup helper (POSIX process groups)", () => {
	function detachedSleeper(): Promise<number> {
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		child.unref();
		return new Promise((resolve, reject) => {
			child.once("spawn", () => (child.pid === undefined ? reject(new Error("no pid")) : resolve(child.pid)));
			child.once("error", reject);
		});
	}

	test("kills a surviving detached fixture by pgid and records fixture_cleanup", async () => {
		const pid = await detachedSleeper();
		const records: unknown[] = [];
		const record = await cleanupDetachedFixture({ launchId: "L9", pid, pgid: pid }, { record: (r: unknown) => records.push(r) });
		expect(record).toEqual({ type: "fixture_cleanup", launchId: "L9", pid, method: "kill -TERM -pgid", gone: true });
		expect(records).toEqual([record]);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("fails when the detached fixture is already gone before cleanup", async () => {
		const pid = await detachedSleeper();
		process.kill(-pid, "SIGKILL");
		await expect(
			cleanupDetachedFixture({ launchId: "L8", pid, pgid: pid }, { record: () => undefined, isAlive: () => false }),
		).rejects.toMatchObject({ code: "fixture_already_gone" });
	});
});
