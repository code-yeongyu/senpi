import * as childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as probes from "../../../src/core/extensions/builtin/terminal/process-start-probe.ts";
import { processStartTimeMs, sameProcessStartMs } from "../../../src/modes/app-server/daemon/process.ts";
import { hostDaemonDirectoryPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { createSessionPathReservations, readSessionPathClaims } from "../../../src/modes/rpc/host-reservations.ts";
import { sessionHeldCheck } from "../../../src/modes/rpc/session-held.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

vi.mock("node:child_process", { spy: true });

const id = "29510000-0000-4000-8000-000000000032";
let root: string;
let file: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "held-snapshot-fallback-"));
	file = join(root, "session.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

it.runIf(process.platform !== "linux")("clears a reused-pid lease after an injected snapshot failure", async () => {
	await using holder = await startSessionHolder(file, id, root);
	const recordFile = join(root, "session-holders", id, `${holder.pid}.json`);
	const record: unknown = JSON.parse(await readFile(recordFile, "utf8"));
	if (
		typeof record !== "object" ||
		record === null ||
		!("processStartedAtMs" in record) ||
		typeof record.processStartedAtMs !== "number"
	)
		throw new Error("Holder did not publish a complete identity");
	await writeFile(recordFile, JSON.stringify({ ...record, processStartedAtMs: record.processStartedAtMs - 600_000 }));
	const fallback = vi.spyOn(probes, "readProcessStartMs");
	vi.mocked(childProcess.execFile).mockImplementationOnce((...args) => {
		const callback = args.at(-1);
		if (typeof callback !== "function") throw new Error("Snapshot callback is absent");
		callback(Object.assign(new Error("Injected snapshot failure"), { cmd: "injected-process-snapshot" }), "", "");
		return new childProcess.ChildProcess();
	});
	await expect(sessionHeldCheck()(file, id)).resolves.toBeUndefined();
	expect(fallback).toHaveBeenCalledExactlyOnceWith(holder.pid);
	await expect(readFile(recordFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it.runIf(process.platform !== "linux")(
	"probes distinct missing foreign pids once across publication rechecks",
	async () => {
		await using first = await startSessionHolder(file, id, root);
		await using second = await startSessionHolder(file, id, root);
		const fallback = vi.spyOn(probes, "readProcessStartMs");
		const processes = vi.mocked(childProcess.execFile);
		processes.mockClear();
		processes.mockImplementationOnce((...args) => {
			const callback = args.at(-1);
			if (typeof callback !== "function") throw new Error("Snapshot callback is absent");
			callback(null, "", "");
			return new childProcess.ChildProcess();
		});
		const check = sessionHeldCheck();
		for (let boundary = 0; boundary < 2; boundary++)
			await expect(check(file, id)).rejects.toMatchObject({ code: "session_held" });
		expect(fallback).toHaveBeenCalledTimes(2);
		expect(fallback).toHaveBeenCalledWith(first.pid);
		expect(fallback).toHaveBeenCalledWith(second.pid);
		expect(processes).toHaveBeenCalledTimes(3);
	},
);

it.runIf(process.platform === "linux")(
	"validates a foreign pid through proc without a process-table spawn",
	async () => {
		await using holder = await startSessionHolder(file, id, root);
		const processes = vi.mocked(childProcess.execFile);
		processes.mockClear();
		await expect(sessionHeldCheck()(file, id)).rejects.toMatchObject({
			code: "session_held",
			detail: { holders: [{ pid: holder.pid, cwd: root }] },
		});
		expect(processes).not.toHaveBeenCalled();
	},
);

it.each(["observation", "claim", "unparseable claim"] as const)(
	"never treats an unknown %s identity as the daemon family",
	async (kind) => {
		await using holder = await startSessionHolder(file, id, root);
		const daemonDir = join(root, "daemon");
		const previous = createSessionPathReservations({ daemonDir, instanceId: "previous", pid: holder.pid });
		await previous.claim(file);
		if (kind !== "observation") {
			const claims = await readSessionPathClaims(hostDaemonDirectoryPaths(daemonDir).reservationsDir);
			const claim = claims[0];
			if (!claim) throw new Error("Claim was not published");
			const processStartTime = kind === "claim" ? null : "legacy timestamp unavailable";
			await writeFile(claim.file, JSON.stringify({ ...claim.owner, processStartTime }));
		}
		const current = createSessionPathReservations({ daemonDir, instanceId: "current" });
		const start = kind !== "observation" ? await probes.readProcessStartMs(holder.pid) : undefined;
		await expect(current.holderPids?.(new Map([[holder.pid, start]]))).resolves.toEqual([]);
	},
);

it.each([
	{ identity: "134359344000000000", started: 1_791_460_800_000 },
	{ identity: "2026-10-08T12:00:00.000Z", started: 1_791_460_800_000 },
	{ identity: "not a process time", started: undefined },
])("parses the shared process identity $identity", ({ identity, started }) => {
	expect(processStartTimeMs(identity)).toBe(started);
});

it("shares the lease and daemon tolerance without accepting an unknown start", () => {
	expect(sameProcessStartMs(1_791_460_800_000, 1_791_460_803_000)).toBe(true);
	expect(sameProcessStartMs(1_791_460_800_000, 1_791_460_803_001)).toBe(false);
	expect(sameProcessStartMs(1_791_460_800_000, undefined)).toBe(false);
});
