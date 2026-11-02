import { describe, expect, it } from "vitest";
import {
	parseWindowsProcessTreeRows,
	type WindowsProcessRow,
	windowsTreeKillArgs,
	windowsTreeKillPlan,
} from "../../src/harness/env/windows-process-tree.ts";

function row(pid: number, parentPid: number, createdAt: number, name = "node.exe"): WindowsProcessRow {
	return { pid, parentPid, createdAt: BigInt(createdAt), name };
}

const SELF = 5000;
// The ancestry a hosted windows-latest runner reports (senpi#2353): wininit.exe names a parent (776) that
// exited at boot, and the agent process descends from wininit.exe.
const host = [
	row(896, 776, 100, "wininit.exe"),
	row(1008, 896, 110, "services.exe"),
	row(6952, 1008, 400, "Runner.Listener.exe"),
	row(SELF, 6952, 500, "bun.exe"),
];

describe("Windows tree kill plan (senpi#2999)", () => {
	it("#given a child whose pid is the recycled pid of wininit's dead parent #when its tree is planned #then wininit and the agent's ancestry stay out", () => {
		// given
		const rows = [...host, row(776, SELF, 600, "bash.exe"), row(7100, 776, 610, "node.exe")];

		// when
		const plan = windowsTreeKillPlan(rows, 776, SELF);

		// then
		expect([...plan.kill].sort((a, b) => a - b)).toEqual([776, 7100]);
		expect(plan.refused).toEqual([]);
	});

	it("#given an older process that names the root's recycled pid #when the tree is planned #then it is not adopted", () => {
		// given
		const rows = [...host, row(7000, SELF, 600, "bash.exe"), row(7200, 7000, 450, "older.exe")];

		// when
		const plan = windowsTreeKillPlan(rows, 7000, SELF);

		// then
		expect(plan.kill).toEqual([7000]);
	});

	it("#given a protected image under the root #when the tree is planned #then only the root is killed and the image is reported", () => {
		// given
		const rows = [...host, row(7000, SELF, 600, "bash.exe"), row(7400, 7000, 610, "svchost.exe")];

		// when
		const plan = windowsTreeKillPlan(rows, 7000, SELF);

		// then
		expect(plan.kill).toEqual([7000]);
		expect(plan.refused).toEqual([{ pid: 7400, name: "svchost.exe" }]);
	});

	it("#given the root is an ancestor of the agent #when the tree is planned #then nothing is killed", () => {
		// when
		const plan = windowsTreeKillPlan(host, 6952, SELF);

		// then
		expect(plan.kill).toEqual([]);
	});

	it("#given a listing #when kill args are built #then each pid is named and /T is never used", () => {
		// given
		const rows = [...host, row(7000, SELF, 600, "bash.exe"), row(7010, 7000, 610)];

		// when
		const args = windowsTreeKillArgs(7000, rows, SELF);

		// then
		expect(args).toEqual(["/F", "/PID", "7000", "/PID", "7010"]);
	});

	it("#given no listing #when kill args are built #then the root alone is killed with /T", () => {
		// when / then
		expect(windowsTreeKillArgs(7000, undefined, SELF)).toEqual(["/F", "/T", "/PID", "7000"]);
	});

	it("#given PowerShell output with CRLF, spaced names and FILETIMEs beyond 2^53 #when parsed #then values are exact", () => {
		// when
		const rows = parseWindowsProcessTreeRows(
			"896 776 134046261411081720 wininit.exe\r\n\r\n0 0 0 System Idle Process\r\nnot a row\r\n",
		);

		// then
		expect(rows).toEqual([{ pid: 896, parentPid: 776, createdAt: 134046261411081720n, name: "wininit.exe" }]);
	});

	it("#given the root is no longer listed #when the tree is planned #then nothing is killed", () => {
		// when
		const plan = windowsTreeKillPlan(host, 7000, SELF);

		// then
		expect(plan.kill).toEqual([]);
	});

	it("#given a protected image as the root #when the tree is planned #then nothing is killed", () => {
		// when
		const plan = windowsTreeKillPlan(host, 1008, SELF);

		// then
		expect(plan.kill).toEqual([]);
		expect(plan.refused).toContainEqual({ pid: 1008, name: "services.exe" });
	});

	it("#given a child created in the same tick as its parent, and one with an unreadable creation time #when planned #then only the same-tick child is adopted", () => {
		// given
		const rows = [...host, row(7000, SELF, 600), row(7010, 7000, 600), row(7020, 7000, 0)];

		// when
		const plan = windowsTreeKillPlan(rows, 7000, SELF);

		// then
		expect([...plan.kill].sort((a, b) => a - b)).toEqual([7000, 7010]);
	});

	it("#given a parent cycle above this process #when the tree is planned #then the ancestor walk ends", () => {
		// given
		const rows = [row(10, 11, 50), row(11, 10, 50), row(SELF, 10, 60), row(7000, SELF, 70), row(7010, 7000, 80)];

		// when
		const plan = windowsTreeKillPlan(rows, 7000, SELF);

		// then
		expect([...plan.kill].sort((a, b) => a - b)).toEqual([7000, 7010]);
	});
});
