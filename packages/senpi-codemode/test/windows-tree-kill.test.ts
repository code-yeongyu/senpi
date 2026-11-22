import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as hostCopy from "../src/kernels/js/windows-tree-kill-host.ts";

type TreeKill = Pick<typeof hostCopy, "windowsTreeKillArgs" | "windowsTreeKillPids">;

// The worker imports the plain-JS copy; .ts files may not import .js, so it is loaded by URL like worker-shell-capture.js.
const workerCopyUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "windows-tree-kill.js")).href;

function isTreeKill(value: unknown): value is TreeKill {
	return (
		typeof value === "object" &&
		value !== null &&
		"windowsTreeKillArgs" in value &&
		typeof value.windowsTreeKillArgs === "function" &&
		"windowsTreeKillPids" in value &&
		typeof value.windowsTreeKillPids === "function"
	);
}

function row(pid: number, parentPid: number, createdAt: number, name = "node.exe") {
	return { pid, parentPid, createdAt: BigInt(createdAt), name };
}

const SELF = 5000;
const host = [
	row(896, 776, 100, "wininit.exe"),
	row(1008, 896, 110, "services.exe"),
	row(6952, 1008, 400, "Runner.Listener.exe"),
	row(SELF, 6952, 500, "bun.exe"),
];

const copies: { name: string; module: TreeKill | undefined }[] = [
	{ name: "host copy", module: hostCopy },
	{ name: "worker copy", module: undefined },
];

beforeAll(async () => {
	const loaded: unknown = await import(workerCopyUrl);
	if (!isTreeKill(loaded)) throw new Error("windows-tree-kill.js does not export the tree kill plan");
	const worker = copies[1];
	if (worker) worker.module = loaded;
});

describe.each(copies)("codemode Windows tree kill, $name (senpi#2999)", (copy) => {
	const plan = (): TreeKill => {
		if (!copy.module) throw new Error(`${copy.name} not loaded`);
		return copy.module;
	};
	it("#given a kernel child on wininit's recycled parent pid #when its tree is planned #then the system tree stays out", () => {
		// given
		const rows = [...host, row(776, SELF, 600, "python.exe"), row(7100, 776, 610)];

		// when
		const pids = plan().windowsTreeKillPids(rows, 776, SELF);

		// then
		expect([...pids].sort((a, b) => a - b)).toEqual([776, 7100]);
	});

	it("#given a protected image under the root #when planned #then only the root is killed", () => {
		// given
		const rows = [...host, row(7000, SELF, 600, "python.exe"), row(7400, 7000, 610, "svchost.exe")];

		// when / then
		expect(plan().windowsTreeKillPids(rows, 7000, SELF)).toEqual([7000]);
	});

	it("#given the root is an ancestor of this process #when planned #then nothing is killed", () => {
		// when / then
		expect(plan().windowsTreeKillPids(host, 6952, SELF)).toEqual([]);
	});

	it("#given a listing or none #when kill args are built #then pids are named without /T, or /T on the root alone", () => {
		// given
		const rows = [...host, row(7000, SELF, 600), row(7010, 7000, 610)];

		// when / then
		expect(plan().windowsTreeKillArgs(7000, rows, SELF)).toEqual(["/F", "/PID", "7000", "/PID", "7010"]);
		expect(plan().windowsTreeKillArgs(7000, undefined, SELF)).toEqual(["/F", "/T", "/PID", "7000"]);
	});

	it("#given an older process that names the root's recycled pid #when planned #then it is not adopted", () => {
		// given
		const rows = [...host, row(7000, SELF, 600, "python.exe"), row(7200, 7000, 450, "older.exe")];

		// when / then
		expect(plan().windowsTreeKillPids(rows, 7000, SELF)).toEqual([7000]);
	});

	it("#given the root is no longer listed #when planned #then nothing is killed", () => {
		// when / then
		expect(plan().windowsTreeKillPids(host, 7000, SELF)).toEqual([]);
	});
});
