import { describe, expect, it } from "vitest";
import {
	bunChromeKillPlan,
	bunChromeTree,
	parseWindowsProcessRows,
	type WindowsProcessRow,
} from "../../../src/core/webview/windows-chrome-tree.ts";

const DEAD_BOOT_PARENT = 776;
const WININIT = 896;
const SERVICES = 1008;
const SVCHOST = 2640;
const HOSTED_COMPUTE_AGENT = 9392;
const RUNNER_LISTENER = 6952;
const RUNNER_WORKER = 6236;
const BUN = 5000;

function row(
	pid: number,
	parentPid: number,
	createdAt: number,
	bunChromeFlag = false,
	name = "chrome.exe",
): WindowsProcessRow {
	return { pid, parentPid, createdAt: BigInt(createdAt), bunChromeFlag, name };
}

// The ancestry a hosted windows-latest runner reports (senpi#2353 probe): wininit.exe names a parent
// that exited at boot, and the runner itself descends from wininit.exe.
const runner = [
	row(WININIT, DEAD_BOOT_PARENT, 100, false, "wininit.exe"),
	row(SERVICES, WININIT, 110, false, "services.exe"),
	row(SVCHOST, SERVICES, 200, false, "svchost.exe"),
	row(HOSTED_COMPUTE_AGENT, SVCHOST, 300, false, "hosted-compute-agent"),
	row(RUNNER_LISTENER, HOSTED_COMPUTE_AGENT, 400, false, "Runner.Listener.exe"),
	row(RUNNER_WORKER, RUNNER_LISTENER, 410, false, "Runner.Worker.exe"),
	row(BUN, RUNNER_WORKER, 500, false, "bun.exe"),
];
const runnerPids = runner.map((process) => process.pid);

describe("Bun's Chrome tree on Windows (senpi#2353)", () => {
	it("#given a Chrome helper handed the recycled pid of wininit's dead parent #when the tree is listed #then the runner's processes stay out", () => {
		// given
		const rows = [...runner, row(7000, BUN, 600, true), row(DEAD_BOOT_PARENT, 7000, 610), row(7100, 7000, 620)];

		// when
		const tree = bunChromeTree(rows, BUN);

		// then
		expect(tree.sort((a, b) => a - b)).toEqual([DEAD_BOOT_PARENT, 7000, 7100]);
		for (const pid of runnerPids) expect(tree).not.toContain(pid);
	});

	it("#given a Chrome browser older than Bun that names Bun's recycled pid #when the tree is listed #then it is not Bun's", () => {
		// given
		const rows = [...runner, row(7200, BUN, 450, true)];

		// when
		const tree = bunChromeTree(rows, BUN);

		// then
		expect(tree).toEqual([]);
	});

	it("#given Bun's Chrome with nested helpers and an unflagged sibling #when the tree is listed #then exactly the browser and its descendants are included", () => {
		// given
		const rows = [
			...runner,
			row(7000, BUN, 600, true),
			row(7010, 7000, 610),
			row(7020, 7010, 620),
			row(7030, BUN, 630),
		];

		// when
		const tree = bunChromeTree(rows, BUN);

		// then
		expect(tree.sort((a, b) => a - b)).toEqual([7000, 7010, 7020]);
	});

	it("#given PowerShell output with CRLF, blank lines, spaced image names and FILETIMEs beyond 2^53 #when parsed #then rows keep exact values", () => {
		// given
		const stdout =
			"896 776 134046261411081720 0 wininit.exe\r\n\r\n0 0 0 0 System Idle Process\r\n7000 5000 134046263569141430 1 chrome.exe\r\nnot a row\r\n";

		// when
		const rows = parseWindowsProcessRows(stdout);

		// then
		expect(rows).toEqual([
			{ pid: 896, parentPid: 776, createdAt: 134046261411081720n, bunChromeFlag: false, name: "wininit.exe" },
			{ pid: 7000, parentPid: 5000, createdAt: 134046263569141430n, bunChromeFlag: true, name: "chrome.exe" },
		]);
	});

	it("#given a protected OS image under Bun's Chrome tree #when the kill plan is made #then it is reported and nothing in that listing is killed", () => {
		// given
		const rows = [...runner, row(7000, BUN, 600, true), row(7400, 7000, 610, false, "svchost.exe")];

		// when
		const plan = bunChromeKillPlan(rows, BUN);

		// then
		expect(plan.kill).toEqual([]);
		expect(plan.skipped).toEqual([{ pid: 7400, name: "svchost.exe", reason: "protected_image" }]);
	});

	it("#given creation times equal to the tick, so an ancestor of Bun passes the creation rule #when the kill plan is made #then that ancestor is skipped, never killed", () => {
		// given
		const rows = [
			row(RUNNER_WORKER, 7000, 500, false, "Runner.Worker.exe"),
			row(BUN, RUNNER_WORKER, 500, false, "bun.exe"),
			row(7000, BUN, 500, true),
		];

		// when
		const plan = bunChromeKillPlan(rows, BUN);

		// then
		expect(bunChromeTree(rows, BUN)).toContain(RUNNER_WORKER);
		expect(plan.kill).toEqual([]);
		expect(plan.skipped).toContainEqual({
			pid: RUNNER_WORKER,
			name: "Runner.Worker.exe",
			reason: "ancestor_of_this_process",
		});
	});

	it("#given the measured runner with a Chrome helper on wininit's recycled parent pid #when the kill plan is made #then only Bun's own Chrome tree is killed and nothing is skipped", () => {
		// given
		const rows = [...runner, row(7000, BUN, 600, true), row(DEAD_BOOT_PARENT, 7000, 610), row(7100, 7000, 620)];

		// when
		const plan = bunChromeKillPlan(rows, BUN);

		// then
		expect([...plan.kill].sort((a, b) => a - b)).toEqual([DEAD_BOOT_PARENT, 7000, 7100]);
		expect(plan.skipped).toEqual([]);
	});
	it("#given a concurrent retirement's listing PowerShell under Bun whose command line names the flag #when the tree is listed #then it is not a Chrome root", () => {
		// given
		const rows = [
			...runner,
			row(7000, BUN, 600, true),
			row(7600, BUN, 650, true, "powershell.exe"),
			row(7610, 7600, 651, false, "conhost.exe"),
		];

		// when
		const tree = bunChromeTree(rows, BUN);

		// then
		expect(tree).toEqual([7000]);
	});
});
