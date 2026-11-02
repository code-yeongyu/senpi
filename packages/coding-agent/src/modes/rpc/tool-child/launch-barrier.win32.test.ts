// senpi#3566 todo 4 (Windows half): the breakaway launch against the real kernel32 (runs in the Windows CI job under
// Bun; skipped with a reason elsewhere, and the CI job refuses a skip).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolChildClient } from "./client.ts";
import { TOOL_CHILD_MODULE_ROOTS_ENV } from "./module-job.ts";
import { loadKernel32Process, startBreakaway } from "./windows-breakaway.ts";
import { windowsCommandLine } from "./windows-command-line.ts";

const kernel = loadKernel32Process();
const reason = process.platform !== "win32" ? "not win32" : kernel === undefined ? "bun:ffi unavailable" : undefined;

const HARD_ARGUMENTS = [
	"plain",
	"",
	"with space",
	"tab\there",
	'a"quote',
	"trailing\\",
	"trailing space \\",
	"C:\\Program Files\\x\\",
	'back\\"slash-quote',
	"unicode é ✓",
];

describe.skipIf(reason !== undefined)(`breakaway launch on kernel32${reason ? ` (skipped: ${reason})` : ""}`, () => {
	it("starts a real command, reports its pid and returns its exit code", () => {
		if (kernel === undefined) throw new Error("unreachable");
		const command = startBreakaway(kernel, windowsCommandLine(["cmd.exe", "/d", "/c", "exit 3"]), process.env);
		expect(command.pid).toBeGreaterThan(0);
		expect(command.wait()).toBe(3);
	});

	it("round-trips hard arguments to a real process's argv", async () => {
		if (kernel === undefined) throw new Error("unreachable");
		const dir = await mkdtemp(join(tmpdir(), "tbw-"));
		try {
			const out = join(dir, "argv.json");
			const script = `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(-${HARD_ARGUMENTS.length})))`;
			const command = startBreakaway(
				kernel,
				windowsCommandLine([process.execPath, "-e", script, ...HARD_ARGUMENTS]),
				process.env,
			);
			expect(command.wait()).toBe(0);
			expect(JSON.parse(await readFile(out, "utf8"))).toEqual(HARD_ARGUMENTS);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

const extensionDir = resolve(import.meta.dirname, "../../../../test/fixtures/module-job-ext");
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");

/** Resolves once `path` contains `needle` (watching its directory), or after `ms` with whatever it holds then. */
function fileContains(path: string, needle: string, ms: number): Promise<void> {
	const holds = () => existsSync(path) && readFileSync(path, "utf8").includes(needle);
	if (holds()) return Promise.resolve();
	return new Promise((resolveWait) => {
		const finish = () => {
			watcher.close();
			clearTimeout(timer);
			resolveWait();
		};
		const watcher = watch(dirname(path), () => {
			if (holds()) finish();
		});
		const timer = setTimeout(finish, ms);
		if (holds()) finish();
	});
}

function processAlive(pid: number): boolean {
	const listed = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
	return listed.includes(String(pid));
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (!processAlive(pid)) return true;
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	return !processAlive(pid);
}

describe.skipIf(reason !== undefined)(`tool child job on kernel32${reason ? ` (skipped: ${reason})` : ""}`, () => {
	it("ends a recorded member when the child is killed, and leaves another session's job untouched", async () => {
		const dirs = [await mkdtemp(join(tmpdir(), "tkw-a-")), await mkdtemp(join(tmpdir(), "tkw-b-"))];
		const client = (dir: string) =>
			new ToolChildClient({
				dir,
				cwd: dir,
				command: { command: process.execPath, args: [roleEntry] },
				env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify([extensionDir]) },
			});
		const [victim, bystander] = [client(dirs[0] ?? ""), client(dirs[1] ?? "")];
		try {
			await victim.start();
			await bystander.start();
			const marker = join(dirs[0] ?? "", "started.txt");
			const started = (await victim.run("module", {
				modulePath: join(extensionDir, "win-gated.ts"),
				export: "startGated",
				args: { params: { marker, gate: `SenpiGateKill${process.pid}` }, toolCallId: "t1" },
			})) as { details: { pid: number } };
			const commandPid = started.details.pid;
			const log = join(dirs[0] ?? "", "launches.jsonl");
			await fileContains(log, '"job_membership"', 10_000);
			const records = (await readFile(log, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(
				records.find((record) => record.type === "job_membership"),
				`launches.jsonl: ${JSON.stringify(records)}`,
			).toMatchObject({ member: true, evidence: "creation" });
			expect(records.some((record) => record.type === "heartbeat")).toBe(false);
			expect(
				processAlive(commandPid),
				`command ${commandPid} gone before the kill; marker=${existsSync(marker)}; launches.jsonl: ${JSON.stringify(records)}`,
			).toBe(true);
			process.kill(victim.pid ?? -1);
			expect(await goneWithin(commandPid, 3_000)).toBe(true);
			const slept = (await bystander.run("module", {
				modulePath: join(extensionDir, "win-gated.ts"),
				export: "sleepFor",
				args: { params: { ms: 200 }, toolCallId: "t2" },
			})) as { details: { pid: number } };
			expect(slept.details.pid).toBe(bystander.pid);
		} finally {
			await victim.close().catch(() => {});
			await bystander.close().catch(() => {});
			for (const dir of dirs) await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
