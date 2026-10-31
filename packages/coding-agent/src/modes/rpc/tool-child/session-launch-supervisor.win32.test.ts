// senpi#4236 review H1: explicit breakaway against the real kernel32 (runs in the Windows CI job, skipped elsewhere).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { processIsLive } from "../../../utils/process-identity.ts";
import type { HeldManagedLaunch } from "./managed-launch-process.ts";
import { SessionLaunchSupervisor } from "./session-launch-supervisor.ts";
import { loadKernel32Job, TOOL_CHILD_JOB_LIMITS, WindowsJob } from "./windows-job.ts";

const kernel = loadKernel32Job();
const reason = process.platform !== "win32" ? "not win32" : kernel === undefined ? "bun:ffi unavailable" : undefined;

type Report = { readonly pid: number } | { readonly error: string };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** A process that waits for the owner's release on stdin, then calls CreateProcessW with CREATE_BREAKAWAY_FROM_JOB. */
async function breakawayProbe(dir: string) {
	const script = join(dir, "breakaway-probe.mjs");
	const grandchild = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
	await writeFile(
		script,
		`import { loadKernel32Process, startBreakaway } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "windows-breakaway.ts")).href)};
process.stdin.once("data", () => {
	let report;
	try {
		report = { pid: startBreakaway(loadKernel32Process(), ${JSON.stringify(grandchild)}, process.env).pid };
	} catch (error) {
		report = { error: error instanceof Error ? error.message : String(error) };
	}
	process.stdout.write(JSON.stringify(report) + "\\n");
	setInterval(() => {}, 1000);
});
`,
	);
	const reports = new Map<number, Report>();
	const prepare = async (): Promise<HeldManagedLaunch> => {
		const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
		const pid = child.pid;
		if (pid === undefined) throw new Error("breakaway probe did not start");
		const exited = once(child, "exit");
		const report = new Promise<Report>((resolve) =>
			createInterface({ input: child.stdout }).once("line", (line) => resolve(JSON.parse(line) as Report)),
		);
		void report.then((value) => {
			reports.set(pid, value);
			if ("pid" in value)
				cleanup.push(async () => {
					if (processIsLive(value.pid)) process.kill(value.pid);
				});
		});
		return {
			pid,
			completed: exited.then(([code]) => (typeof code === "number" ? code : 1)),
			release: async () => {
				child.stdin.write("release\n");
				await report;
				return pid;
			},
			close: async () => {
				if (child.exitCode === null && child.signalCode === null) child.kill();
				await exited;
			},
		};
	};
	return { prepare, reports };
}

async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "managed-breakaway-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

describe.skipIf(reason !== undefined)(
	`managed launch Job Objects on kernel32${reason ? ` (skipped: ${reason})` : ""}`,
	() => {
		it("refuses CREATE_BREAKAWAY_FROM_JOB inside a managed launch, and session close ends the launch", async () => {
			const dir = await directory();
			const { prepare, reports } = await breakawayProbe(dir);
			const owner = new SessionLaunchSupervisor({ dir, prepare });
			cleanup.push(() => owner.close());
			const command = { command: "breakaway-probe", args: [], cwd: dir, env: {}, logPath: join(dir, "probe.log") };

			const launch = await owner.start(command, "call-a");
			await owner.close();

			expect(reports.get(launch.pid)).toEqual({
				error: expect.stringContaining("CreateProcessW failed (win32 error 5)"),
			});
			expect(processIsLive(launch.pid)).toBe(false);
		}, 30_000);

		it("control: the same request leaves a job created with the tool-child generation's flags", async () => {
			if (kernel === undefined) throw new Error("unreachable");
			const dir = await directory();
			const { prepare, reports } = await breakawayProbe(dir);
			const job = WindowsJob.create(kernel, TOOL_CHILD_JOB_LIMITS);
			const held = await prepare();
			try {
				job.assign(held.pid);
				await held.release();
				const report = reports.get(held.pid);

				expect(report).toEqual({ pid: expect.any(Number) });
				expect(job.memberPids()).toContain(held.pid);
				expect(job.memberPids()).not.toContain(report !== undefined && "pid" in report ? report.pid : -1);
			} finally {
				job.terminate();
				job.close();
				await held.close();
			}
		}, 30_000);
	},
);
