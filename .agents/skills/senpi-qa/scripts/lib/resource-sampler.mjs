// SC-SOAK resource sampler (plan QX4, P0-05h).
//
// It only observes: it reads the process table and the open files of a host's process tree from outside (`ps`,
// `/proc` on Linux, `lsof` on macOS). The parsers are pure; `readProcessTable`, `readOpenFiles` and
// `sampleProcessTree` read the live machine. The second half is the band math over a recorded run: B0's bands and the
// budget check of a later run, pure functions over a run summary.
import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Process tree
// ---------------------------------------------------------------------------

/** Parse `ps -A -o pid=,ppid=,rss=,command=` output. Lines that do not start with three integers are skipped. */
export function parsePsTable(text) {
	const rows = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line);
		if (match)
			rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] });
	}
	return rows;
}

/** Every process below `rootPid` (not the root itself), breadth first. */
export function descendants(rows, rootPid) {
	const byParent = new Map();
	for (const row of rows) {
		if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
		byParent.get(row.ppid).push(row);
	}
	const out = [];
	const queue = [rootPid];
	const seen = new Set(queue);
	while (queue.length > 0) {
		for (const child of byParent.get(queue.shift()) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			out.push(child);
			queue.push(child.pid);
		}
	}
	return out;
}

/** The live process table. POSIX only: soak runs on macOS and Linux fleet machines. */
export async function readProcessTable() {
	if (process.platform === "win32")
		throw new Error("resource-sampler: the process table is read with ps (macOS, Linux)");
	const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { maxBuffer: 64 * MB });
	return parsePsTable(stdout);
}

/** A PTY master as a file name: `/dev/ptmx` (macOS, Linux) or `/dev/pts/ptmx` (a Linux devpts mount). */
export const isPtyMaster = (name) => name === "/dev/ptmx" || name === "/dev/pts/ptmx";

/**
 * Parse `lsof -n -P -F pfn` output into per-pid open files. Only numeric descriptors count; `cwd`, `txt`, `rtd` and
 * memory-mapped entries are not descriptors.
 */
export function parseLsof(text) {
	const byPid = new Map();
	let pid;
	let fd;
	for (const line of text.split("\n")) {
		const tag = line[0];
		const value = line.slice(1);
		if (tag === "p") {
			pid = Number(value);
			if (!byPid.has(pid)) byPid.set(pid, []);
			fd = undefined;
		} else if (tag === "f") {
			fd = /^\d+$/.test(value) ? Number(value) : undefined;
		} else if (tag === "n" && pid !== undefined && fd !== undefined) {
			byPid.get(pid).push({ fd, name: value });
			fd = undefined;
		}
	}
	return byPid;
}

/** Open descriptors of each pid, as `Map<pid, {fd, name}[]>`. A pid that exited meanwhile is absent. */
async function readOpenFiles(pids) {
	if (pids.length === 0) return new Map();
	if (process.platform === "linux") {
		const byPid = new Map();
		for (const pid of pids) {
			let entries;
			try {
				entries = await readdir(`/proc/${pid}/fd`);
			} catch {
				continue;
			}
			const files = [];
			for (const entry of entries) {
				try {
					files.push({ fd: Number(entry), name: await readlink(`/proc/${pid}/fd/${entry}`) });
				} catch {}
			}
			byPid.set(pid, files);
		}
		return byPid;
	}
	if (process.platform === "darwin") {
		// lsof exits 1 when one of the pids is gone; its output for the others is still complete.
		const out = await run("lsof", ["-n", "-P", "-F", "pfn", "-p", pids.join(",")], { maxBuffer: 64 * MB }).catch(
			(error) => ({ stdout: typeof error.stdout === "string" ? error.stdout : "" }),
		);
		return parseLsof(out.stdout);
	}
	throw new Error(`resource-sampler: open files are not readable on ${process.platform}`);
}

/**
 * One external sample of a host's process tree:
 * - `rssMb`: the host process's own resident set; `treeRssMb`: host plus descendants;
 * - `fds`: the host process's open descriptors;
 * - `children`: live descendant processes; `mcp`: descendants whose command line contains `mcpMarker`;
 * - `ptys`: PTY masters open anywhere in the tree.
 * It throws when the host's own open files could not be read (lsof or /proc failed): recording 0 would pass every leak
 * check. `openFiles` replaces the live reader in tests.
 */
export async function sampleProcessTree(rootPid, { mcpMarker, openFiles = readOpenFiles } = {}) {
	const rows = await readProcessTable();
	const root = rows.find((row) => row.pid === rootPid);
	if (!root) throw new Error(`resource-sampler: process ${rootPid} is not running`);
	const tree = descendants(rows, rootPid);
	const files = await openFiles([rootPid, ...tree.map((row) => row.pid)]);
	if (!files.has(rootPid))
		throw new Error(`resource-sampler: no open-file listing for host process ${rootPid} (lsof or /proc read failed)`);
	let ptys = 0;
	for (const list of files.values()) ptys += list.filter((file) => isPtyMaster(file.name)).length;
	return {
		rssMb: root.rssKb / 1024,
		treeRssMb: (root.rssKb + tree.reduce((sum, row) => sum + row.rssKb, 0)) / 1024,
		fds: files.get(rootPid).length,
		children: tree.length,
		mcp: mcpMarker ? tree.filter((row) => row.command.includes(mcpMarker)).length : 0,
		ptys,
	};
}

// ---------------------------------------------------------------------------
// B0 bands and budgets (SC-SOAK)
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** The counters that must return to B0's post-wave level after every wave. */
export const POST_WAVE_COUNTERS = ["fds", "children", "ptys", "kernels", "mcp"];

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentile (p in 0..100) of a non-empty list. */
export function percentile(values, p) {
	if (values.length === 0) throw new Error("percentile of an empty list");
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Least-squares slope of `points` ({t: ms, v}) in units per hour, with its standard error. Fewer than three points,
 * or all at one instant, has no slope.
 */
export function slopePerHour(points) {
	if (points.length < 3) return undefined;
	const n = points.length;
	const xs = points.map((point) => point.t / HOUR_MS);
	const meanX = xs.reduce((a, b) => a + b, 0) / n;
	const meanY = points.reduce((a, point) => a + point.v, 0) / n;
	let sxx = 0;
	let sxy = 0;
	for (let i = 0; i < n; i++) {
		sxx += (xs[i] - meanX) ** 2;
		sxy += (xs[i] - meanX) * (points[i].v - meanY);
	}
	if (sxx === 0) return undefined;
	const slope = sxy / sxx;
	const intercept = meanY - slope * meanX;
	let sse = 0;
	for (let i = 0; i < n; i++) sse += (points[i].v - (intercept + slope * xs[i])) ** 2;
	return { slope, se: Math.sqrt(sse / (n - 2) / sxx) };
}

/** Split timed items ({t}) into consecutive windows of `windowMs` from `startMs`; empty windows are dropped. */
export function windowsOf(items, windowMs, startMs) {
	const buckets = new Map();
	for (const item of items) {
		const index = Math.floor((item.t - startMs) / windowMs);
		if (index < 0) continue;
		if (!buckets.has(index)) buckets.set(index, []);
		buckets.get(index).push(item);
	}
	return [...buckets.entries()].sort(([a], [b]) => a - b).map(([index, list]) => ({ index, items: list }));
}

/** p50 and p95 of call latency per window. */
export function latencyByWindow(calls, windowMs, startMs) {
	return windowsOf(calls, windowMs, startMs).map(({ index, items }) => {
		const ms = items.map((call) => call.ms);
		return { window: index, calls: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95) };
	});
}

// ---------------------------------------------------------------------------
// B0 bands and budgets
// ---------------------------------------------------------------------------

/**
 * A run summary is `{ startMs, warmupEndMs, windowMs, samples: [{t, rssMb, heapMb, ...}], postWave: [{wave, t, fds,
 * children, ptys, kernels, mcp}], calls: [{t, ms}] }`. Samples before `warmupEndMs` (the first wave) are not part of the
 * slope: they include the start-up ramp.
 */
function steadySeries(summary, key) {
	return summary.samples
		.filter((sample) => sample.t >= summary.warmupEndMs && Number.isFinite(sample[key]))
		.map((sample) => ({ t: sample.t, v: sample[key] }));
}

/** Slope band floor, in MB per hour, so a perfectly flat B0 does not make every candidate's noise a breach. */
export const SLOPE_FLOOR_MB_PER_HOUR = 1;

/**
 * B0 bands from a recorded run:
 * - `postWave`: per counter, the highest level B0 returned to after any wave;
 * - `slope.rssMb` / `slope.heapMb`: B0's steady-state slope plus or minus max(3 standard errors, the floor), MB/h;
 * - `latency.p50` / `latency.p95`: the lowest and highest per-window value over B0's windows, ms;
 * - `drift`: the range of each window's p95 relative to the first window's p95 (0 = no drift).
 */
export function buildBands(summary) {
	if (summary.postWave.length === 0) throw new Error("buildBands: the run completed no wave");
	const postWave = Object.fromEntries(
		POST_WAVE_COUNTERS.map((counter) => [counter, Math.max(...summary.postWave.map((level) => level[counter]))]),
	);
	const slope = {};
	for (const key of ["rssMb", "heapMb"]) {
		const fit = slopePerHour(steadySeries(summary, key));
		if (!fit) throw new Error(`buildBands: too few steady-state ${key} samples for a slope`);
		const tol = Math.max(3 * fit.se, SLOPE_FLOOR_MB_PER_HOUR);
		slope[key] = { slope: fit.slope, lo: fit.slope - tol, hi: fit.slope + tol };
	}
	const windows = latencyByWindow(summary.calls, summary.windowMs, summary.startMs);
	if (windows.length === 0) throw new Error("buildBands: the run recorded no call latency");
	const range = (values) => ({ lo: Math.min(...values), hi: Math.max(...values) });
	const first = windows[0].p95;
	return {
		windowMs: summary.windowMs,
		postWave,
		slope,
		latency: { p50: range(windows.map((w) => w.p50)), p95: range(windows.map((w) => w.p95)) },
		drift: range(windows.map((w) => w.p95 / first - 1)),
	};
}

/**
 * Check a run against B0 bands (SC-SOAK budgets). Placement `fused` is held to B0's hourly p95 band; other placements,
 * which have no "today", are held to B0's drift band from their first window to their last. Returns the three receipt
 * booleans and every violation, each naming the counter, window or series that broke.
 */
export function checkBudgets(summary, bands, { placement }) {
	const violations = [];
	if (summary.postWave.length === 0) violations.push({ check: "post_wave", detail: "the run completed no wave" });
	for (const level of summary.postWave) {
		for (const counter of POST_WAVE_COUNTERS) {
			if (level[counter] > bands.postWave[counter])
				violations.push({
					check: "post_wave",
					detail: `wave ${level.wave}: ${counter}=${level[counter]} above B0 post-wave level ${bands.postWave[counter]}`,
				});
		}
	}
	for (const key of ["rssMb", "heapMb"]) {
		const fit = slopePerHour(steadySeries(summary, key));
		if (!fit) violations.push({ check: "slope", detail: `${key}: too few steady-state samples for a slope` });
		else if (fit.slope > bands.slope[key].hi)
			violations.push({
				check: "slope",
				detail: `${key} slope ${fit.slope.toFixed(2)} MB/h above B0 band hi ${bands.slope[key].hi.toFixed(2)}`,
			});
	}
	const windows = latencyByWindow(summary.calls, bands.windowMs, summary.startMs);
	if (windows.length === 0) violations.push({ check: "latency", detail: "the run recorded no call latency" });
	else if (placement === "fused") {
		for (const w of windows) {
			if (w.p95 > bands.latency.p95.hi)
				violations.push({
					check: "latency",
					detail: `window ${w.window}: p95 ${w.p95} ms above B0 band hi ${bands.latency.p95.hi} ms`,
				});
		}
	} else {
		const drift = windows.at(-1).p95 / windows[0].p95 - 1;
		if (drift > bands.drift.hi)
			violations.push({
				check: "latency",
				detail: `p95 drift ${(drift * 100).toFixed(1)}% above B0 drift band hi ${(bands.drift.hi * 100).toFixed(1)}%`,
			});
	}
	const ok = (check) => !violations.some((violation) => violation.check === check);
	return {
		post_wave_levels_ok: ok("post_wave"),
		slopes_in_band: ok("slope"),
		latency_in_band: ok("latency"),
		violations,
	};
}
