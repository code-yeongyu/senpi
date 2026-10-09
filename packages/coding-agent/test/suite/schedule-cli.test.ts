/**
 * `senpi schedule` against the REAL source CLI in a child process: the contract under test is what
 * a service manager (launchd, systemd, cron) observes when it runs the runner - stdout lines, exit
 * codes, and what the delivery hook receives - so nothing here is stubbed.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createScheduledJob,
	listScheduledJobs,
	scheduleDir,
} from "../../src/core/extensions/builtin/schedule/store.ts";
import { assertWorkspaceBuildPrerequisite } from "../support/workspace-build-prerequisite.ts";

// The spawned source CLI resolves workspace packages through their built dist (see the helper).
assertWorkspaceBuildPrerequisite(import.meta.url);

const cliEntry = join(import.meta.dirname, "..", "..", "src", "cli.ts");
const sandboxes: string[] = [];
const children: ChildProcess[] = [];

const orphanGroups: number[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	for (const group of orphanGroups.splice(0)) {
		try {
			process.kill(-group, "SIGKILL");
		} catch {
			// already exited
		}
	}
	await Promise.all(sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sandbox(): Promise<{ root: string; agentDir: string; dir: string }> {
	const root = await mkdtemp(join(tmpdir(), "senpi-schedule-cli-"));
	sandboxes.push(root);
	const agentDir = join(root, "agent");
	return { root, agentDir, dir: scheduleDir(agentDir) };
}

function spawnCli(agentDir: string, args: string[]): ChildProcess {
	const child = spawn(process.execPath, [cliEntry, "schedule", ...args], {
		// SENPI_RUNTIME=bun (set in every omo session) would re-exec the CLI under Bun behind a wrapper
		// process, so `child.pid` would not be the runner these tests signal and look up.
		env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", SENPI_RUNTIME: "node" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}

function runCli(agentDir: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawnCli(agentDir, args);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`expected a JSON object line, got ${JSON.stringify(value)}`);
	}
	return Object.fromEntries(Object.entries(value));
}

function jsonLines(stdout: string): Record<string, unknown>[] {
	return stdout
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.map((line) => asRecord(JSON.parse(line)));
}

/** Resolves with the first complete stdout JSON line matching `predicate`, or rejects after `timeoutMs`. */
function nextJsonLine(
	child: ChildProcess,
	predicate: (line: Record<string, unknown>) => boolean,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let pending = "";
		const onData = (chunk: Buffer) => {
			pending += chunk.toString("utf8");
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline).trim();
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
				if (!line.startsWith("{")) continue;
				const parsed = asRecord(JSON.parse(line));
				if (predicate(parsed)) {
					finish();
					resolve(parsed);
					return;
				}
			}
		};
		const timer = setTimeout(() => {
			finish();
			reject(new Error(`no matching line within ${timeoutMs}ms`));
		}, timeoutMs);
		const finish = () => {
			clearTimeout(timer);
			child.stdout?.off("data", onData);
		};
		child.stdout?.on("data", onData);
	});
}

const job = (dueAt: number) => ({
	sessionId: "omocat-1553768016783867985",
	sessionFile: null,
	cwd: "/",
	prompt: "remind Howard about the PR review",
	dueAt,
	everyMs: null,
});

describe("senpi schedule --exec on every platform", () => {
	it("runs an operator command whose quoted program and script paths contain spaces", async () => {
		const { root, agentDir, dir } = await sandbox();
		const hookDir = join(root, "hook dir");
		await mkdir(hookDir);
		const hook = join(hookDir, "hook.mjs");
		const out = join(root, "hook stdin.json");
		await writeFile(
			hook,
			`import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, readFileSync(0, "utf8"));\n`,
		);
		const created = await createScheduledJob(dir, job(Date.now() - 1000), Date.now() - 60_000);

		const result = await runCli(agentDir, ["run", "--exec", `"${process.execPath}" "${hook}"`]);

		expect(result.code, result.stdout + result.stderr).toBe(0);
		expect(jsonLines(result.stdout)).toEqual([
			expect.objectContaining({ event: "fired", id: created.id, outcome: "delivered" }),
		]);
		expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ type: "scheduled_prompt", id: created.id });
	}, 60_000);
});

describe.skipIf(process.platform === "win32")("senpi schedule", () => {
	it("run --exec hands a due job to the hook as JSON on stdin, exactly once", async () => {
		const { root, agentDir, dir } = await sandbox();
		const created = await createScheduledJob(dir, job(Date.now() - 1000), Date.now() - 60_000);
		const future = await createScheduledJob(dir, job(Date.now() + 3_600_000), Date.now());
		const out = join(root, "hook-stdin.json");

		const first = await runCli(agentDir, [
			"run",
			"--exec",
			`cat > '${out}'; echo "$SENPI_SCHEDULE_SESSION_ID" > '${out}.env'`,
		]);
		const second = await runCli(agentDir, ["run", "--exec", `echo again >> '${out}.again'`]);

		expect(first.code).toBe(0);
		expect(jsonLines(first.stdout)).toEqual([
			expect.objectContaining({ event: "fired", id: created.id, occurrence: 1, outcome: "delivered" }),
		]);
		expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({
			type: "scheduled_prompt",
			id: created.id,
			sessionId: "omocat-1553768016783867985",
			prompt: "remind Howard about the PR review",
			fireCount: 1,
		});
		expect((await readFile(`${out}.env`, "utf8")).trim()).toBe("omocat-1553768016783867985");
		expect(second.code).toBe(0);
		expect(existsSync(`${out}.again`)).toBe(false);
		expect((await listScheduledJobs(dir)).jobs.map(({ job }) => job.id)).toEqual([future.id]);
	}, 60_000);

	it("run exits 1 and keeps the job in failed/ when the hook fails", async () => {
		const { agentDir, dir } = await sandbox();
		const created = await createScheduledJob(dir, job(Date.now() - 1000), Date.now() - 60_000);

		const result = await runCli(agentDir, ["run", "--exec", "echo inbox unavailable >&2; exit 7"]);

		expect(result.code).toBe(1);
		expect(jsonLines(result.stdout)).toEqual([
			expect.objectContaining({
				event: "fired",
				id: created.id,
				outcome: "failed",
				error: "exit code 7: inbox unavailable",
			}),
		]);
		expect((await listScheduledJobs(dir)).jobs).toEqual([
			expect.objectContaining({ state: "failed", occurrence: 1, job: expect.objectContaining({ id: created.id }) }),
		]);
	}, 60_000);

	it("list --json and cancel manage jobs across sessions", async () => {
		const { agentDir, dir } = await sandbox();
		const created = await createScheduledJob(dir, job(Date.now() + 600_000), Date.now());

		const listed = await runCli(agentDir, ["list", "--json"]);
		expect(listed.code).toBe(0);
		expect(JSON.parse(listed.stdout)).toMatchObject({
			jobs: [{ state: "pending", id: created.id, sessionId: "omocat-1553768016783867985" }],
			invalid: [],
			runners: [],
		});

		const cancelled = await runCli(agentDir, ["cancel", created.id]);
		const missing = await runCli(agentDir, ["cancel", created.id]);
		expect(cancelled.code).toBe(0);
		expect(missing.code).toBe(1);
		expect((await listScheduledJobs(dir)).jobs).toEqual([]);
	}, 60_000);

	it("run --watch is woken by a job created after it started and stops cleanly on SIGTERM", async () => {
		const { root, agentDir, dir } = await sandbox();
		const out = join(root, "watched.json");
		// An hour-long poll: only the pending/ watch can deliver within the test deadline.
		const runner = spawnCli(agentDir, ["run", "--watch", "--poll-seconds", "3600", "--exec", `cat > '${out}'`]);
		await nextJsonLine(runner, (line) => line.event === "watching", 30_000);
		const listed = await runCli(agentDir, ["list", "--json"]);
		expect(JSON.parse(listed.stdout).runners).toEqual([
			expect.objectContaining({ pid: runner.pid, watch: true, fresh: true }),
		]);

		const fired = nextJsonLine(runner, (line) => line.event === "fired", 30_000);
		const created = await createScheduledJob(dir, job(Date.now()), Date.now());
		expect(await fired).toMatchObject({ id: created.id, outcome: "delivered" });
		expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ id: created.id });

		const exited = new Promise<number | null>((resolve) => runner.on("close", (code) => resolve(code)));
		runner.kill("SIGTERM");
		expect(await exited).toBe(0);
		expect(existsSync(join(dir, "runners", `${runner.pid}.json`))).toBe(false);
	}, 90_000);

	it("does not start a second delivery into a session while a crashed runner's delivery still runs", async () => {
		const { root, agentDir, dir } = await sandbox();
		const started = join(root, "started");
		const release = join(root, "release");
		const second = join(root, "second-delivered");
		execFileSync("mkfifo", [started, release]);
		const first = await createScheduledJob(dir, job(Date.now() - 2000), Date.now() - 60_000);
		const next = await createScheduledJob(dir, job(Date.now() - 1000), Date.now() - 60_000);

		// Runner 1 delivers job 1 through a hook that reports itself, then blocks until released.
		const runner1 = spawnCli(agentDir, [
			"run",
			"--exec",
			`cat > /dev/null; echo "$$ $SENPI_SCHEDULE_ID" > '${started}'; cat '${release}' > /dev/null`,
		]);
		const [hookPid, deliveredId] = (await readFile(started, "utf8")).trim().split(" ");
		orphanGroups.push(Number(hookPid));
		const runner1Closed = new Promise<void>((resolve) => runner1.on("close", () => resolve()));
		runner1.kill("SIGKILL");
		await runner1Closed;

		// Runner 2 must not deliver job 2 while the orphaned hook of job 1 is still running.
		const runner2 = await runCli(agentDir, ["run", "--exec", `cat > /dev/null; touch '${second}'`]);
		await writeFile(release, "go\n");

		expect(deliveredId).toBe(first.id);
		expect(jsonLines(runner2.stdout)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event: "abandoned", id: first.id }),
				expect.objectContaining({ event: "deferred", id: next.id }),
			]),
		);
		expect(existsSync(second)).toBe(false);
	}, 90_000);

	it("rejects an unknown subcommand with usage and exit 2", async () => {
		const { agentDir } = await sandbox();
		const result = await runCli(agentDir, ["frobnicate"]);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
	}, 60_000);
});
