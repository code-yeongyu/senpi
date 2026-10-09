import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareSessionOpening } from "../../../src/cli/session-opening.ts";
import { holdSessionFile } from "../../../src/core/session-holders.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";

// senpi#2951: exercise host admission, not just the lease reader.
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const fixture = new URL("./issue-2951-holder-fixture.mjs", import.meta.url);
let root: string;
let sessionFile: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "senpi-held-regression-"));
	sessionFile = join(root, "session.jsonl");
	await writeFile(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: root, timestamp: new Date().toISOString() })}\n`,
	);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

async function startHolder(cwd: string | null = root) {
	const child = spawn(
		process.execPath,
		["--import", "tsx", fileURLToPath(fixture), sessionFile, SESSION_ID, ...(cwd === null ? [] : [cwd])],
		{
			cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			env: { PATH: process.env.PATH, HOME: root, SENPI_CODING_AGENT_DIR: join(root, "agent") },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const exited = once(child, "exit");
	try {
		const [chunk] = await once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) });
		expect(String(chunk)).toBe("HELD\n");
	} catch (cause) {
		child.kill();
		await exited;
		throw cause;
	}
	const pid = child.pid;
	if (pid === undefined) throw new Error("Holder did not start");
	return {
		pid,
		async stop(crash = false) {
			if (child.exitCode !== null || child.signalCode !== null) return;
			if (crash) child.kill("SIGKILL");
			else child.stdin.end("release\n");
			await exited;
		},
		async [Symbol.asyncDispose]() {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill();
				await exited;
			}
		},
	};
}

it("refuses open with session_held and only the foreign holder pid/cwd", async () => {
	await using holder = await startHolder();
	await using rig = createInProcessRig(root);
	const response = await rig.open("client", { sessionPath: sessionFile });
	expect(response).toMatchObject({
		success: false,
		error: "session_held",
		errorCode: "session_held",
	});
	expect(response?.errorData).toEqual({ holders: [{ pid: holder.pid, cwd: root }] });
	expect(rig.registry.size).toBe(0);
});

it.each(["prompt", "steer"] as const)("refuses %s on an already-open session until the holder exits", async (type) => {
	const handled: string[] = [];
	await using rig = createInProcessRig(root, undefined, async (command) => {
		handled.push(command.type);
	});
	await rig.open("client", { sessionPath: sessionFile });
	const sessionId = (await rig.list())[0]?.sessionId;
	if (sessionId === undefined) throw new Error("Host did not open session");
	await using holder = await startHolder();
	const refusal = await rig.send("client", { id: "blocked", type, sessionId, message: "hello" });
	expect(refusal).toMatchObject({ success: false, error: "session_held", errorCode: "session_held" });
	expect(refusal?.errorData).toEqual({ holders: [{ pid: holder.pid, cwd: root }] });
	expect(handled).toEqual([]);
	await holder.stop();
	await rig.send("client", { id: "retry", type, sessionId, message: "hello" });
	expect(handled).toEqual([type]);
});

it("opens after the foreign holder exits without restarting the host", async () => {
	await using rig = createInProcessRig(root);
	await using holder = await startHolder();
	expect(await rig.open("client", { sessionPath: sessionFile })).toMatchObject({ error: "session_held" });
	await holder.stop();
	expect(await rig.open("client", { sessionPath: sessionFile })).toMatchObject({ success: true });
});

it("refuses an attach when a foreign holder appears after the first open", async () => {
	await using rig = createInProcessRig(root);
	expect(await rig.open("client", { sessionPath: sessionFile })).toMatchObject({ success: true });
	await using holder = await startHolder(null);
	const response = await rig.open("other", { sessionPath: sessionFile });
	expect(response).toMatchObject({ success: false, errorCode: "session_held" });
	expect(response?.errorData).toEqual({ holders: [{ pid: holder.pid }] });
	expect((await rig.list())[0]?.attachments).toBe(1);
});

it("warns interactive startup with the holder pid/cwd and clears after exit", async () => {
	await using holder = await startHolder();
	const manager = SessionManager.open(sessionFile);
	const warning = vi.spyOn(console, "error").mockImplementation(() => {});
	await prepareSessionOpening(manager, "interactive");
	expect(warning).toHaveBeenCalledTimes(1);
	const text = String(warning.mock.calls[0]?.[0]);
	expect(text).toContain(String(holder.pid));
	expect(text).toContain(root);
	expect(text.split("\n")).toHaveLength(1);
	await holder.stop();
	warning.mockClear();
	await prepareSessionOpening(manager, "interactive");
	expect(warning).not.toHaveBeenCalled();
});

it("opens when a crashed holder leaves a dead-pid record", async () => {
	await using holder = await startHolder();
	expect(holder.pid).not.toBe(process.pid);
	await holder.stop(true);
	const record = JSON.parse(
		await readFile(join(dirname(sessionFile), "session-holders", SESSION_ID, `${holder.pid}.json`), "utf8"),
	);
	expect(record.pid).toBe(holder.pid);
	expect(record.processStartedAtMs).toEqual(expect.any(Number));
	await using rig = createInProcessRig(root);
	expect(await rig.open("client", { sessionPath: sessionFile })).toMatchObject({ success: true });
});

it("does not block its own process holder", async () => {
	const hold = holdSessionFile(sessionFile, SESSION_ID, { cwd: root, expectExisting: true });
	try {
		await using rig = createInProcessRig(root);
		expect(await rig.open("client", { sessionPath: sessionFile })).toMatchObject({ success: true });
	} finally {
		hold.release();
	}
});

it("does not block a holder in its own worker runtime", async () => {
	const worker = new Worker(fixture, { workerData: [sessionFile, SESSION_ID, root], execArgv: ["--import", "tsx"] });
	const exited = once(worker, "exit");
	try {
		const [pid] = await once(worker, "message", { signal: AbortSignal.timeout(10_000) });
		expect(pid).toBe(process.pid);
		await using rig = createInProcessRig(root);
		expect(await rig.open("client", { sessionPath: sessionFile })).toMatchObject({ success: true });
	} finally {
		worker.postMessage("release");
		await exited;
	}
});

it.each(["bootAtMs", "processStartedAtMs"])("ignores a complete live foreign holder with stale %s", async (field) => {
	await using holder = await startHolder();
	expect(holder.pid).not.toBe(process.pid);
	const recordFile = join(dirname(sessionFile), "session-holders", SESSION_ID, `${holder.pid}.json`);
	const record = JSON.parse(await readFile(recordFile, "utf8"));
	expect(record.bootAtMs).toEqual(expect.any(Number));
	expect(record.processStartedAtMs).toEqual(expect.any(Number));
	record[field] -= 600_000;
	await writeFile(recordFile, JSON.stringify(record));
	await using rig = createInProcessRig(root);
	expect(await rig.open("client", { sessionPath: sessionFile })).toMatchObject({ success: true });
});

it("keeps interactive startup advisory when the holder lookup has a filesystem error", async () => {
	await mkdir(join(root, "session-holders"));
	await writeFile(join(root, "session-holders", SESSION_ID), "not a directory");
	const warning = vi.spyOn(console, "error").mockImplementation(() => {});
	await expect(prepareSessionOpening(SessionManager.open(sessionFile), "interactive")).resolves.toBeUndefined();
	expect(warning).toHaveBeenCalledTimes(1);
});
