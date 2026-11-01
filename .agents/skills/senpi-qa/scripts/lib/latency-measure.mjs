// EQ.perf statistics (plan P0-05f, §6.5): turn timestamped tool-call iterations into per-run p50/p95 metrics, build
// B0's run-to-run band, and judge a candidate against it; plus the two measuring primitives the driver
// (scenarios/fused-latency-qa.mjs) uses: the barrier clock, the body-clock wrapper extension and the CPU calibration.
//
// Band and candidate shapes are the ones $GATE/z1-check.mjs reads:
//   band      { machine_class, child_runtime, metrics: { <metric>: { p50: {min,max}, p95: {min,max} } } }
//   candidate { machine_class, child_runtime, metrics: { <metric>: { p50, p95 } } }
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

/** The two dispatch metrics (§6.5). Each is reported over all workloads and per workload (`E01.<metric>`). */
const DISPATCH_METRICS = ["dispatch_to_body_ms", "body_to_next_request_ms"];
/** TUI frame time (§6.5): the interval between consecutive rendered frames while E01's answer streams. */
export const TUI_FRAME_METRIC = "tui_frame_ms";

const QUANTILES = { p50: 0.5, p95: 0.95 };
const round = (ms) => Math.round(ms * 100) / 100;

/** Nearest-rank percentile of a non-empty sample list; `q` in (0, 1]. */
export function percentile(samples, q) {
	if (!Array.isArray(samples) || samples.length === 0) throw new Error("percentile of an empty sample list");
	if (!(q > 0 && q <= 1)) throw new Error(`percentile q must be in (0, 1], got ${q}`);
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.ceil(q * sorted.length) - 1];
}

/**
 * Samples of one iteration (one prompt whose provider answer carried a tool-call batch).
 * `callAt`: when the provider emitted the tool calls; `nextAt`: when the next provider request arrived;
 * `bodies`: the bodies that ran, each `{ id, readyAt, startAt, endAt }`, where `readyAt` is the moment the body could
 * start (the tool-call event, or for a sequential successor the previous body's end).
 */
export function iterationSamples({ callAt, nextAt, bodies }) {
	if (!bodies.length) throw new Error("an iteration needs at least one body that ran");
	for (const body of bodies) {
		for (const key of ["readyAt", "startAt", "endAt"])
			if (typeof body[key] !== "number") throw new Error(`body ${body.id} has no ${key}`);
	}
	if (typeof callAt !== "number" || typeof nextAt !== "number") throw new Error("iteration without callAt/nextAt");
	return {
		dispatch_to_body_ms: bodies.map((body) => body.startAt - body.readyAt),
		body_to_next_request_ms: [nextAt - Math.max(...bodies.map((body) => body.endAt))],
	};
}

/** Words per streamed answer before its marker. */
const ANSWER_WORDS = 30;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** A letter-only word for `n` (bijective base 26: a..z, aa..): digit runs would all collapse to one token below. */
function letterWord(n) {
	let word = "";
	for (let rest = n + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) word = LETTERS[(rest - 1) % 26] + word;
	return word;
}

/**
 * The answer TUI frame iteration `i` streams. Its closing marker `E01-STREAMED-<i>` is on screen only once the last delta
 * rendered. The TTSR repetitive-turns rule collapses digit runs and interrupts the third near-identical turn in a row,
 * which sends an unscripted provider request that takes the next iteration's scripted turn (senpi#5270), so every
 * iteration's words are letter-only and unique to it: no two answers share a word trigram before the marker.
 */
export function streamedAnswer(i) {
	const words = Array.from({ length: ANSWER_WORDS }, (_, k) => `q${letterWord(i * ANSWER_WORDS + k)}`);
	return `${words.join(" ")} E01-STREAMED-${i}`;
}

/**
 * Frame-time samples of one streaming window. `chunks` are the EQ.tui capture's output chunks (`{ at, frameEnds }`, the
 * capture's `frames`) from the stream's release through the chunk whose frame shows its last delta. A frame ends where
 * the renderer's synchronized-output FRAME_END marker arrives, so a frame split over several PTY reads is one frame
 * however far apart its pieces land; each interval between consecutive frame ends is one sample. A window with fewer
 * than two frame ends is an error, never an empty or zero sample.
 */
export function frameIntervals(chunks) {
	const ends = [];
	for (const { at, frameEnds } of chunks) {
		if (typeof at !== "number" || !Number.isInteger(frameEnds))
			throw new Error("a frame chunk has no arrival time or frame-end count");
		for (let k = 0; k < frameEnds; k++) ends.push(at);
	}
	if (ends.length < 2) throw new Error(`a streaming window needs at least two frames, got ${ends.length}`);
	return ends.slice(1).map((at, index) => at - ends[index]);
}

/**
 * One run's metrics from `{ <workload id>: iteration[] }` and the run's TUI frame-time samples: aggregate and
 * per-workload dispatch p50/p95, plus `tui_frame_ms`, each with its sample count.
 */
export function runMetrics(workloads, frameSamples) {
	if (!Array.isArray(frameSamples) || frameSamples.length === 0)
		throw new Error(`a run needs ${TUI_FRAME_METRIC} samples`);
	const pooled = Object.fromEntries(DISPATCH_METRICS.map((metric) => [metric, []]));
	const metrics = {};
	for (const [id, iterations] of Object.entries(workloads)) {
		const own = Object.fromEntries(DISPATCH_METRICS.map((metric) => [metric, []]));
		for (const iteration of iterations) {
			const samples = iterationSamples(iteration);
			for (const metric of DISPATCH_METRICS) own[metric].push(...samples[metric]);
		}
		for (const metric of DISPATCH_METRICS) {
			metrics[`${id}.${metric}`] = summarize(own[metric]);
			pooled[metric].push(...own[metric]);
		}
	}
	for (const metric of DISPATCH_METRICS) metrics[metric] = summarize(pooled[metric]);
	metrics[TUI_FRAME_METRIC] = summarize(frameSamples);
	return metrics;
}

function summarize(samples) {
	return {
		p50: round(percentile(samples, QUANTILES.p50)),
		p95: round(percentile(samples, QUANTILES.p95)),
		n: samples.length,
	};
}

/** B0's band: per metric and quantile, the min and max of the runs' values (§6.5). Every run must carry every metric. */
export function bandOf(runs) {
	if (!runs.length) throw new Error("a band needs at least one run");
	const names = Object.keys(runs[0].metrics).sort();
	const band = {};
	for (const name of names) {
		band[name] = {};
		for (const q of Object.keys(QUANTILES)) {
			const values = runs.map((run, index) => {
				const value = run.metrics[name]?.[q];
				if (typeof value !== "number") throw new Error(`run ${index + 1} has no ${name}.${q}`);
				return value;
			});
			band[name][q] = { min: Math.min(...values), max: Math.max(...values) };
		}
	}
	return band;
}

/** The candidate's value per metric and quantile: the minimum over its runs (min-of-N, lead ruling at M0). */
export function minOfRuns(runs) {
	if (!runs.length) throw new Error("a candidate needs at least one run");
	const out = {};
	for (const name of Object.keys(runs[0].metrics).sort()) {
		out[name] = {};
		for (const q of Object.keys(QUANTILES)) {
			const values = runs.map((run) => run.metrics[name]?.[q]).filter((value) => typeof value === "number");
			if (values.length !== runs.length) throw new Error(`a candidate run has no ${name}.${q}`);
			out[name][q] = Math.min(...values);
		}
	}
	return out;
}

/**
 * Judge a candidate against B0's band. Findings use z1-check's codes: a different machine class or child runtime
 * is not comparable, a band metric the candidate lacks is missing, and a quantile above the band's max is a Z1 diff.
 */
export function compareToBand(candidate, band) {
	const findings = [];
	if (candidate.machine_class !== band.machine_class)
		findings.push({
			code: "PERF_MACHINE_CLASS",
			detail: `candidate ${candidate.machine_class} vs B0 ${band.machine_class}`,
		});
	if (candidate.child_runtime !== band.child_runtime)
		findings.push({
			code: "PERF_CHILD_RUNTIME",
			detail: `candidate ${candidate.child_runtime} vs B0 ${band.child_runtime}`,
		});
	for (const [name, limits] of Object.entries(band.metrics)) {
		const measured = candidate.metrics[name];
		if (!measured) {
			findings.push({ code: "PERF_METRIC_MISSING", detail: name });
			continue;
		}
		for (const q of Object.keys(QUANTILES)) {
			if (measured[q] > limits[q].max)
				findings.push({
					code: "PERF_ABOVE_BAND",
					detail: `${name}.${q}=${measured[q]} > B0 max ${limits[q].max}`,
				});
		}
	}
	return findings;
}

/** The machine class a band belongs to: the CPU model without vendor prefix or spaces, and the core count. */
export function machineClass(cpuModel, cores) {
	const model = String(cpuModel ?? "unknown")
		.replace(/^Apple\s+/i, "")
		.replace(/[^A-Za-z0-9]/g, "");
	return `${model || "unknown"}-${cores}c`;
}

/** Release every named barrier the moment it is reached, recording when. */
export function barrierClock(run) {
	const at = new Map();
	return {
		arm(names) {
			for (const name of names)
				run.server.barrierArrived(name).then(() => {
					at.set(name, performance.now());
					run.server.releaseBarrier(name);
				});
		},
		read(name) {
			const value = at.get(name);
			if (value === undefined) throw new Error(`barrier ${name} was never reached`);
			return value;
		},
	};
}

/** A fixed CPU workload, recorded beside each run so a loaded host shows in the receipt (lead ruling at M0). */
export function calibrate() {
	const started = performance.now();
	const block = Buffer.alloc(1 << 20, 7);
	let digest = Buffer.alloc(32);
	for (let k = 0; k < 64; k++) digest = createHash("sha256").update(block).update(digest).digest();
	return Math.round((performance.now() - started) * 100) / 100;
}

/** A wrapper extension that pings `perf-start:<id>` / `perf-end:<id>` around every tool body the fixture registers. */
export function wrapExtension(dir, fixture) {
	const path = join(dir, `perf-wrap-${basename(fixture)}`);
	writeFileSync(
		path,
		`import inner from ${JSON.stringify(pathToFileURL(fixture).href)};
const ping = (name) => fetch(process.env.EQ_BARRIER_ORIGIN + "/__barrier/" + encodeURIComponent(name)).then((r) => r.text());
export default function perfWrapped(pi) {
	inner(new Proxy(pi, { get(target, key) {
		if (key === "registerTool") return (tool) => target.registerTool({ ...tool, async execute(id, ...rest) {
			await ping("perf-start:" + id);
			try { return await tool.execute(id, ...rest); } finally { await ping("perf-end:" + id); }
		} });
		const value = Reflect.get(target, key);
		return typeof value === "function" ? value.bind(target) : value;
	} }));
}
`,
	);
	return path;
}
