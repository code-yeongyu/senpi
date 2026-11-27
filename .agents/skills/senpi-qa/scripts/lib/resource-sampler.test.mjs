// node --test .agents/skills/senpi-qa/scripts/lib/resource-sampler.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { SOAK_MCP_TOOL, soakStep, stepOf } from "../scenarios/soak-qa.mjs";
import {
	buildBands,
	checkBudgets,
	descendants,
	isPtyMaster,
	latencyByWindow,
	parseLsof,
	parsePsTable,
	percentile,
	readProcessTable,
	SLOPE_FLOOR_MB_PER_HOUR,
	sampleProcessTree,
	slopePerHour,
	windowsOf,
} from "./resource-sampler.mjs";

test("parsePsTable reads pid, ppid, rss and the full command; other lines are skipped", () => {
	const rows = parsePsTable("  10     1  2048 /usr/bin/node a b\nnot a row\n  11    10     4 sh -c sleep 5\n");
	assert.deepEqual(rows, [
		{ pid: 10, ppid: 1, rssKb: 2048, command: "/usr/bin/node a b" },
		{ pid: 11, ppid: 10, rssKb: 4, command: "sh -c sleep 5" },
	]);
});

test("descendants walks the whole subtree, not the root, and ignores other trees", () => {
	const rows = [
		{ pid: 1, ppid: 0 },
		{ pid: 10, ppid: 1 },
		{ pid: 11, ppid: 10 },
		{ pid: 12, ppid: 11 },
		{ pid: 20, ppid: 1 },
	];
	assert.deepEqual(
		descendants(rows, 10).map((row) => row.pid),
		[11, 12],
	);
	assert.deepEqual(descendants(rows, 12), []);
});

test("parseLsof keeps numeric descriptors per pid and drops cwd, txt and mapped entries", () => {
	const text = [
		"p10",
		"fcwd",
		"n/work",
		"ftxt",
		"n/bin/bun",
		"f0",
		"n/dev/null",
		"f7",
		"n/dev/ptmx",
		"p11",
		"f3",
		"n/tmp/x",
		"",
	].join("\n");
	const byPid = parseLsof(text);
	assert.deepEqual(byPid.get(10), [
		{ fd: 0, name: "/dev/null" },
		{ fd: 7, name: "/dev/ptmx" },
	]);
	assert.deepEqual(byPid.get(11), [{ fd: 3, name: "/tmp/x" }]);
});

test("isPtyMaster names the PTY master device on macOS and Linux only", () => {
	assert.equal(isPtyMaster("/dev/ptmx"), true);
	assert.equal(isPtyMaster("/dev/pts/ptmx"), true);
	assert.equal(isPtyMaster("/dev/pts/3"), false);
	assert.equal(isPtyMaster("/dev/ttys004"), false);
});

/**
 * A live tree under a shell: a plain sleeper, a node process whose command line carries a marker, and `script`
 * running a sleeper inside a PTY. Each member prints its letter once it runs (the PTY member from inside the PTY), so the
 * tree is complete when all three letters have arrived: four descendants, one marked, one PTY master.
 */
async function startTree() {
	const inPty = `sh -c 'echo p; exec sleep 30'`;
	const members = {
		SOAK_A: "echo s; exec sleep 30",
		SOAK_B: `exec node -e 'console.log("m"); setTimeout(() => {}, 30000)' soak-marker-x`,
		SOAK_C:
			process.platform === "darwin" ? `exec script -q /dev/null ${inPty}` : `exec script -qfc "${inPty}" /dev/null`,
	};
	const root = spawn("sh", ["-c", 'eval "$SOAK_A" & eval "$SOAK_B" & eval "$SOAK_C" & wait'], {
		env: { ...process.env, ...members },
		stdio: ["ignore", "pipe", "ignore"],
	});
	let out = "";
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`the test tree did not start: ${JSON.stringify(out)}`)), 30_000);
		root.stdout.on("data", (chunk) => {
			out += chunk.toString();
			if (["s", "m", "p"].every((letter) => out.includes(letter))) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	return root;
}

test(
	"sampleProcessTree counts a live tree's children, marked children and PTY masters",
	{ skip: process.platform === "win32" },
	async () => {
		const root = await startTree();
		try {
			const sample = await sampleProcessTree(root.pid, { mcpMarker: "soak-marker-x" });
			assert.equal(sample.children, 4, "the sleeper, the marked node, script and its PTY child");
			assert.equal(sample.mcp, 1);
			assert.equal(sample.ptys, 1);
			assert.ok(sample.fds >= 0);
			assert.ok(sample.rssMb > 0 && sample.treeRssMb >= sample.rssMb);
		} finally {
			const rows = await readProcessTable();
			for (const row of descendants(rows, root.pid)) process.kill(row.pid, "SIGKILL");
			root.kill("SIGKILL");
			await once(root, "close");
		}
	},
);

test("sampleProcessTree refuses a process that is not running", async () => {
	const child = spawn("sh", ["-c", "exit 0"]);
	await once(child, "close");
	await assert.rejects(sampleProcessTree(child.pid), /is not running/);
});

test("sampleProcessTree refuses to record 0 descriptors when the host's own open files could not be read", async () => {
	const missingHost = async (pids) => new Map(pids.slice(1).map((pid) => [pid, []]));
	await assert.rejects(
		sampleProcessTree(process.pid, { openFiles: missingHost }),
		new RegExp(`no open-file listing for host process ${process.pid}`),
	);
	const sample = await sampleProcessTree(process.pid, {
		openFiles: async (pids) => new Map(pids.map((pid) => [pid, [{ fd: 0, name: "/dev/ptmx" }]])),
	});
	assert.equal(sample.fds, 1);
});

const HOUR = 3_600_000;
const MIN = 60_000;

test("percentile is nearest-rank and refuses an empty list", () => {
	assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
	assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
	assert.equal(percentile([7], 50), 7);
	assert.throws(() => percentile([], 50), /empty/);
});

test("slopePerHour fits units per hour and needs three spread points", () => {
	const fit = slopePerHour([0, 1, 2, 3].map((h) => ({ t: h * HOUR, v: 10 + 4 * h })));
	assert.ok(Math.abs(fit.slope - 4) < 1e-9);
	assert.ok(fit.se < 1e-9);
	assert.equal(
		slopePerHour([
			{ t: 0, v: 1 },
			{ t: HOUR, v: 2 },
		]),
		undefined,
	);
	assert.equal(
		slopePerHour([
			{ t: 5, v: 1 },
			{ t: 5, v: 2 },
			{ t: 5, v: 3 },
		]),
		undefined,
	);
});

test("windowsOf buckets from the start, drops empty windows and items before the start", () => {
	const items = [{ t: -1 }, { t: 0 }, { t: 59 }, { t: 130 }];
	assert.deepEqual(
		windowsOf(items, 60, 0).map((w) => [w.index, w.items.length]),
		[
			[0, 2],
			[2, 1],
		],
	);
});

test("latencyByWindow reports p50 and p95 per window", () => {
	const calls = [10, 20, 30, 40].map((ms, i) => ({ t: i, ms })).concat([{ t: 100, ms: 5 }]);
	assert.deepEqual(latencyByWindow(calls, 100, 0), [
		{ window: 0, calls: 4, p50: 20, p95: 40 },
		{ window: 1, calls: 1, p50: 5, p95: 5 },
	]);
});

/** A two-hour run: one sample a minute, waves every 10 minutes, calls every minute. */
function run({ rssPerHour = 0, heapPerHour = 0, level = {}, latency = () => 100 } = {}) {
	const samples = [];
	const calls = [];
	for (let m = 0; m <= 120; m++) {
		const h = m / 60;
		const wobble = m % 2 === 0 ? 0.2 : -0.2;
		samples.push({ t: m * MIN, rssMb: 300 + rssPerHour * h + wobble, heapMb: 80 + heapPerHour * h + wobble });
		calls.push({ t: m * MIN, ms: latency(m) });
	}
	const postWave = [];
	for (let wave = 1; wave <= 12; wave++)
		postWave.push({ wave, t: wave * 10 * MIN, fds: 40, children: 3, ptys: 0, kernels: 2, mcp: 2, ...level });
	return { startMs: 0, warmupEndMs: 10 * MIN, windowMs: HOUR, samples, postWave, calls };
}

test("buildBands records post-wave levels, slope bands with the floor, latency and drift bands", () => {
	const bands = buildBands(run({ latency: (m) => (m < 60 ? 100 : 120) }));
	assert.deepEqual(bands.postWave, { fds: 40, children: 3, ptys: 0, kernels: 2, mcp: 2 });
	assert.ok(Math.abs(bands.slope.rssMb.slope) < 0.5);
	assert.ok(bands.slope.rssMb.hi - bands.slope.rssMb.slope >= SLOPE_FLOOR_MB_PER_HOUR);
	assert.deepEqual(bands.latency.p95, { lo: 100, hi: 120 });
	assert.ok(Math.abs(bands.drift.hi - 0.2) < 1e-9);
	assert.throws(() => buildBands({ ...run(), postWave: [] }), /no wave/);
});

test("checkBudgets passes a run equal to B0", () => {
	const b0 = run();
	const verdict = checkBudgets(run(), buildBands(b0), { placement: "fused" });
	assert.deepEqual(verdict, {
		post_wave_levels_ok: true,
		slopes_in_band: true,
		latency_in_band: true,
		violations: [],
	});
});

test("checkBudgets names each post-wave counter that stays above B0's level", () => {
	const bands = buildBands(run());
	for (const counter of ["fds", "children", "ptys", "kernels", "mcp"]) {
		const verdict = checkBudgets(run({ level: { [counter]: bands.postWave[counter] + 1 } }), bands, {
			placement: "fused",
		});
		assert.equal(verdict.post_wave_levels_ok, false, counter);
		assert.match(verdict.violations[0].detail, new RegExp(`${counter}=\\d+ above B0 post-wave level`));
		assert.equal(verdict.slopes_in_band && verdict.latency_in_band, true);
	}
});

test("checkBudgets fails an RSS or heap slope above B0's band", () => {
	const bands = buildBands(run());
	for (const [key, opts] of [
		["rssMb", { rssPerHour: 50 }],
		["heapMb", { heapPerHour: 50 }],
	]) {
		const verdict = checkBudgets(run(opts), bands, { placement: "fused" });
		assert.equal(verdict.slopes_in_band, false, key);
		assert.match(verdict.violations[0].detail, new RegExp(`^${key} slope`));
	}
});

test("fused is held to B0's hourly p95 band; other placements to B0's drift band", () => {
	const bands = buildBands(run({ latency: (m) => (m < 60 ? 100 : 110) }));
	const slower = run({ latency: () => 200 });
	const fused = checkBudgets(slower, bands, { placement: "fused" });
	assert.equal(fused.latency_in_band, false);
	assert.match(fused.violations[0].detail, /p95 200 ms above B0 band hi 110 ms/);
	// Flat at 200 ms: no drift, so a placement without a "today" passes; doubling over the run does not.
	assert.equal(checkBudgets(slower, bands, { placement: "split-local" }).latency_in_band, true);
	const drifting = checkBudgets(run({ latency: (m) => (m < 60 ? 100 : 200) }), bands, { placement: "split-local" });
	assert.equal(drifting.latency_in_band, false);
	assert.match(drifting.violations[0].detail, /p95 drift 100\.0% above B0 drift band hi 10\.0%/);
});

// The soak-qa fake model's script (one prompt = reads, the eval cell, the MCP call, the closing text).

const prompt = (n) => ({ role: "user", content: [{ type: "text", text: `<environment_context/>\nsoak turn ${n}` }] });
const assistant = { role: "assistant", content: null };
const tool = { role: "tool", content: "ok" };

test("soakStep scripts reads, the eval cell, the MCP call, then the closing text", () => {
	assert.deepEqual(
		soakStep(0, "p").toolCalls.map((call) => call.name),
		["read", "read"],
	);
	assert.equal(soakStep(1, "p").toolCalls[0].name, "eval");
	assert.equal(soakStep(2, "p").toolCalls[0].name, SOAK_MCP_TOOL);
	assert.equal(soakStep(3, "p").text, "SOAK-TURN-DONE");
});

test("stepOf counts the assistant messages after the latest soak prompt", () => {
	assert.equal(stepOf([prompt(1)]).step, 0);
	assert.equal(stepOf([prompt(1), assistant, tool, tool]).step, 1);
	assert.equal(stepOf([prompt(1), assistant, tool, assistant, tool, assistant, prompt(2)]).step, 0);
});

test("an engine notice with the user role mid-turn does not restart the turn's script", () => {
	const notice = {
		role: "user",
		content: [
			{ type: "text", text: "<system-reminder>Background terminal session bash_2 finished</system-reminder>" },
		],
	};
	assert.equal(stepOf([prompt(1), assistant, tool, tool, assistant, tool, notice]).step, 2);
});

test("call ids are unique per request position", () => {
	assert.notEqual(stepOf([prompt(1)]).idPrefix, stepOf([prompt(1), assistant, tool]).idPrefix);
});
