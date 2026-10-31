// senpi#3566 todo 4 (Windows half): on win32 every gated child_process launch is contained by the job and reports the
// command it started, so the server can record creation-time membership. Runs on every OS with the platform injected.
import realChildProcess from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BarrierClock } from "./barrier-clock.ts";
import { breakawayCommandLine, createGatedChildProcess } from "./gated-child-process.ts";
import { LAUNCH_SHIM_COMMAND_LINE_ENV, TOOL_CHILD_REENTRY_ENV, withoutInternalEnv } from "./launch-env-names.ts";
import { WorkerLaunchClient, type WorkerLaunchMessage } from "./worker-launch.ts";

function recordingClient() {
	const messages: WorkerLaunchMessage[] = [];
	const client = new WorkerLaunchClient({
		clockBuffer: BarrierClock.create().buffer,
		post: (message) => messages.push(message),
		jobId: () => "job-1",
		skipAckWait: true,
	});
	return { client, messages };
}

describe("gated child_process in win32 mode", () => {
	it("records job containment and reports the started pid for spawnSync", () => {
		const { client, messages } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32");
		const result = cp.spawnSync("true");
		const launch = messages.find((message) => message.kind === "launch");
		expect(launch?.kind === "launch" ? launch.request.containment : undefined).toBe("job");
		expect(messages.filter((message) => message.kind === "started")).toEqual([
			{ kind: "started", launchId: launch?.launchId, pid: result.pid, breakaway: false },
		]);
	});

	it("reports the started pid for spawn", async () => {
		const { client, messages } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32");
		const child = cp.spawn("true", [], { stdio: "ignore" });
		await new Promise((resolveExit) => child.once("exit", resolveExit));
		expect(messages.find((message) => message.kind === "started")).toMatchObject({ pid: child.pid });
	});

	it("fails typed when a detached launch has no re-entry command for the shim", () => {
		const { client } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32", undefined);
		expect(() => cp.spawn("true", [], { detached: true })).toThrow(/^tool_child_breakaway_failed: /);
	});

	it("starts a detached launch through the shim, as breakaway, and reports the pid the shim wrote on fd 3", async () => {
		const { client, messages } = recordingClient();
		const stubShim = 'require("node:fs").writeSync(3, JSON.stringify({ pid: 4321 }) + "\\n")';
		const reentry = JSON.stringify({ command: process.execPath, args: ["-e", stubShim] });
		const cp = createGatedChildProcess(realChildProcess, client, "win32", reentry);
		const shim = cp.spawn("cmd.exe", ["/c", "exit 0"], { detached: true, stdio: "ignore" });
		await new Promise((resolveExit) => shim.once("exit", resolveExit));
		expect(messages.find((message) => message.kind === "launch")).toMatchObject({
			request: { api: "cp.spawn", containment: "breakaway", lifetime: "detached" },
		});
		expect(messages.find((message) => message.kind === "started")).toMatchObject({ pid: 4321, breakaway: true });
	});

	it("gives the shim no internal variable of its caller, and the verbatim cmd.exe /c line of a shell launch", async () => {
		// senpi#3590 review HIGH 1 + MEDIUM 2-3: the shim's environment starts from the one sanitizer, so a re-entry or
		// shim command line the caller carried never reaches the shim (nor, through it, the user's command).
		const { client } = recordingClient();
		const dir = await mkdtemp(join(tmpdir(), "tcbreak-"));
		const seen = join(dir, "seen.json");
		const stubShim = [
			'const fs = require("node:fs");',
			`fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ reentry: process.env.${TOOL_CHILD_REENTRY_ENV} ?? null, line: process.env.${LAUNCH_SHIM_COMMAND_LINE_ENV} ?? process.env.SENPI_LAUNCH_SHIM_ARGV ?? null }));`,
			'fs.writeSync(3, JSON.stringify({ pid: 4321 }) + "\\n");',
		].join(" ");
		const reentry = JSON.stringify({ command: process.execPath, args: ["-e", stubShim] });
		const cp = createGatedChildProcess(realChildProcess, client, "win32", reentry);
		const saved = process.env[TOOL_CHILD_REENTRY_ENV];
		process.env[TOOL_CHILD_REENTRY_ENV] = reentry;
		try {
			const shim = cp.spawn("echo", ['"a b"'], {
				detached: true,
				shell: true,
				stdio: "ignore",
				env: {
					...process.env,
					ComSpec: "cmd.exe",
					[TOOL_CHILD_REENTRY_ENV]: reentry,
					[LAUNCH_SHIM_COMMAND_LINE_ENV]: "stale",
				},
			});
			await new Promise((resolveExit) => shim.once("exit", resolveExit));
			expect(JSON.parse(await readFile(seen, "utf8"))).toEqual({
				reentry: null,
				line: 'cmd.exe /d /s /c "echo "a b""',
			});
		} finally {
			if (saved === undefined) delete process.env[TOOL_CHILD_REENTRY_ENV];
			else process.env[TOOL_CHILD_REENTRY_ENV] = saved;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("builds a detached shell launch's command line by the shell's own convention", () => {
		// senpi#3590 review MEDIUM: only cmd.exe takes `/d /s /c "<command>"`; any other shell takes `-c <command>`, as Node does.
		const cases: ReadonlyArray<readonly [string | boolean, NodeJS.ProcessEnv, string]> = [
			[true, {}, 'cmd.exe /d /s /c "echo hi"'],
			[true, { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, 'C:\\Windows\\System32\\cmd.exe /d /s /c "echo hi"'],
			["cmd", {}, 'cmd /d /s /c "echo hi"'],
			["powershell.exe", {}, 'powershell.exe -c "echo hi"'],
			["C:\\Program Files\\Git\\bin\\bash.exe", {}, '"C:\\Program Files\\Git\\bin\\bash.exe" -c "echo hi"'],
		];
		for (const [shell, env, expected] of cases)
			expect(breakawayCommandLine("echo", ["hi"], shell, env)).toBe(expected);
	});

	it("strips an internal variable whatever its case on Windows", () => {
		// senpi#3590 review LOW: Windows environment names are case-insensitive.
		const env = { senpi_tool_child_reentry: "{}", Senpi_Internal_Role: "launch-shim", Path: "C:\\bin" };
		expect(withoutInternalEnv(env, "win32")).toEqual({ Path: "C:\\bin" });
		expect(withoutInternalEnv(env, "linux")).toEqual(env);
	});

	it("keeps POSIX launches inherited with no started report", () => {
		const { client, messages } = recordingClient();
		createGatedChildProcess(realChildProcess, client, "darwin").spawnSync("true");
		expect(messages.find((message) => message.kind === "launch")).toMatchObject({
			request: { containment: "inherited" },
		});
		expect(messages.some((message) => message.kind === "started")).toBe(false);
	});
});
