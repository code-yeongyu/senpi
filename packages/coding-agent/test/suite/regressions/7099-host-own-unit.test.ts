/**
 * senpi#7099: on Linux/systemd a host supervisor started by `host ensure` stayed in its caller's cgroup, so
 * stopping the caller's transient unit (a terminal's service, an ssh scope, a CI job) SIGTERMed the shared host.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { probeProtocolInfo } from "../../../src/modes/rpc/host-probe.ts";
import { readHostStatus } from "../../../src/modes/rpc/host-status.ts";
import {
	decideHostUnitPlacement,
	hostUnitFromCgroupTable,
	placedLaunch,
	probeHostUnitPlacement,
} from "../../../src/modes/rpc/host-unit-placement.ts";
import { stopHost } from "../../../src/modes/rpc/host-stop.ts";
import { STOP_WAIT_BUDGET_MS } from "../../../src/modes/rpc/host-ensure-stop.ts";
import {
	endpointScratch,
	hostArgs,
	hostEnv,
	sweepEndpointScratches,
	trackSupervisor,
} from "../../helpers/rpc-host-endpoint-scratch.ts";
import { hostLifecycleEntry } from "../../helpers/rpc-generation-support.ts";
import { processAlive, waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

const CALLER = join(import.meta.dirname, "..", "..", "fixtures", "host-unit-caller.ts");

function userManagerReachable(): boolean {
	if (process.platform !== "linux") return false;
	try {
		execFileSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8", stdio: "pipe" });
		return true;
	} catch (error: unknown) {
		const stdout = (error as { stdout?: unknown }).stdout;
		return typeof stdout === "string" && /^(degraded|starting|initializing|maintenance)$/mu.test(stdout);
	}
}

function systemctl(...args: string[]): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("systemctl", ["--user", ...args], { stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout: stdout.trim() }));
	});
}

async function unitProperty(unit: string, property: string): Promise<string> {
	return (await systemctl("show", "-p", property, "--value", unit)).stdout;
}

function closed(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("close", () => resolve()));
}

function firstLine(child: ChildProcess & { readonly stdout: Readable }, stderr: () => string): Promise<string> {
	return new Promise((resolve, reject) => {
		const lines = createInterface({ input: child.stdout });
		lines.once("line", (line) => {
			lines.close();
			resolve(line);
		});
		child.once("close", (code) => reject(new Error(`caller unit ended (${code}) before the host: ${stderr()}`)));
	});
}

const callerUnits: { unit: string; process: ChildProcess }[] = [];
const hostUnits: string[] = [];

afterEach(async () => {
	for (const { unit, process: caller } of callerUnits.splice(0)) {
		await systemctl("stop", unit);
		await closed(caller);
		expect(await unitProperty(unit, "ActiveState")).not.toBe("active");
	}
	await sweepEndpointScratches();
	for (const unit of hostUnits.splice(0)) expect(await unitProperty(unit, "ActiveState")).not.toBe("active");
});

describe("where a generation's supervisor is placed", () => {
	const launch = {
		command: "/usr/bin/bun",
		args: ["host-lifecycle.ts", "--socket", "/s/rpc.sock", "--owner-fd", "3"],
	};
	const linux = { platform: "linux" as const, userManager: true, systemdRun: "/usr/bin/systemd-run" };

	it("starts the supervisor in its own collected scope, execing the same argv, when the user manager answers", () => {
		const placement = decideHostUnitPlacement("0b0e", linux);
		expect(placement).toEqual({
			kind: "own_unit",
			unit: "senpi-host-0b0e.scope",
			systemdRun: "/usr/bin/systemd-run",
		});
		expect(placedLaunch(launch, placement)).toEqual({
			command: "/usr/bin/systemd-run",
			args: [
				"--user",
				"--scope",
				"--unit=senpi-host-0b0e.scope",
				"--collect",
				"--quiet",
				"--",
				...[launch.command, ...launch.args],
			],
		});
	});

	it.each([
		[{ ...linux, platform: "darwin" as const }, "not_linux"],
		[{ ...linux, userManager: false }, "no_user_manager"],
		[{ ...linux, systemdRun: undefined }, "no_systemd_run"],
	])("keeps today's spawn without a usable manager (%o)", (probe, reason) => {
		const placement = decideHostUnitPlacement("0b0e", probe);
		expect(placement).toEqual({ kind: "caller_unit", reason });
		expect(placedLaunch(launch, placement)).toBe(launch);
	});

	it("does not look for a user manager without XDG_RUNTIME_DIR or off Linux", async () => {
		expect(await probeHostUnitPlacement({ PATH: "/usr/bin" }, "linux")).toEqual({
			platform: "linux",
			userManager: false,
			systemdRun: undefined,
		});
		expect(await probeHostUnitPlacement({ PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1" }, "darwin")).toEqual({
			platform: "darwin",
			userManager: false,
			systemdRun: undefined,
		});
	});

	it("names the unit a generation's cgroup belongs to and whether it is its own", () => {
		const terminal = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/term-4c3d.service\n";
		expect(hostUnitFromCgroupTable(terminal, "0b0e")).toEqual({
			cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/term-4c3d.service",
			name: "term-4c3d.service",
			own: false,
		});
		expect(hostUnitFromCgroupTable("0::/user.slice/u@1.service/app.slice/senpi-host-0b0e.scope\n", "0b0e")).toEqual({
			cgroup: "/user.slice/u@1.service/app.slice/senpi-host-0b0e.scope",
			name: "senpi-host-0b0e.scope",
			own: true,
		});
		expect(hostUnitFromCgroupTable("12:pids:/x\n1:name=systemd:/session-3.scope\n", "0b0e")?.name).toBe(
			"session-3.scope",
		);
		expect(hostUnitFromCgroupTable("0::/\n", "0b0e")).toEqual({ cgroup: "/", name: null, own: false });
	});
});

const reachable = userManagerReachable();

describe.skipIf(!reachable)(
	"a host started from a caller inside a transient unit (needs a user systemd manager; skipped when `systemctl --user is-system-running` cannot reach one)",
	() => {
		it("outlives the caller's unit and still answers get_protocol_info", async () => {
			const qa = endpointScratch("u7099");
			const unit = `senpi-test-7099-${randomBytes(4).toString("hex")}.service`;
			const passed = ["PATH", "HOME", "LANG", "TMPDIR", "XDG_RUNTIME_DIR", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"]
				.filter((name) => process.env[name] !== undefined)
				.map((name) => `--setenv=${name}=${process.env[name]}`);
			const input = {
				socket: qa.legacy,
				agentDir: qa.agentDir,
				entry: hostLifecycleEntry(),
				hostArgs: hostArgs(),
				env: hostEnv(qa),
			};
			const caller = spawn(
				"systemd-run",
				[
					"--user",
					`--unit=${unit}`,
					"--collect",
					"--quiet",
					"--pipe",
					...passed,
					"--",
					process.execPath,
					CALLER,
					JSON.stringify(input),
				],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			callerUnits.push({ unit, process: caller });
			let stderr = "";
			caller.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			const { pid } = JSON.parse(await firstLine(caller, () => stderr)) as { pid: number };
			trackSupervisor(pid);

			const instanceId = (await probeProtocolInfo(qa.legacy, 10_000))?.instanceId;
			if (instanceId === undefined) throw new Error("the ensured host did not answer get_protocol_info");
			const ownUnit = `senpi-host-${instanceId}.scope`;
			hostUnits.push(ownUnit);

			expect((await systemctl("stop", unit)).code).toBe(0);
			await closed(caller);

			expect(processAlive(pid)).toBe(true);
			const after = await probeProtocolInfo(qa.legacy, 10_000);
			expect(after?.instanceId).toBe(instanceId);

			const status = await readHostStatus({ socket: qa.legacy, agentDir: qa.agentDir });
			const row = status.generations.find((generation) => generation.pid === pid);
			expect(row?.unit).toEqual({
				name: ownUnit,
				own: true,
				cgroup: expect.stringMatching(new RegExp(`/${ownUnit}$`, "u")),
			});

			const stopped = await stopHost({ socket: qa.legacy, agentDir: qa.agentDir });
			expect(stopped.action).toBe("stopped");
			expect(await waitForPidGone(pid, STOP_WAIT_BUDGET_MS)).toBe(true);
		});
	},
);
