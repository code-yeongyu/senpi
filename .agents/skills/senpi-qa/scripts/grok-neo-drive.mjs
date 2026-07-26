#!/usr/bin/env node
/**
 * Grok-neo PTY capture driver.
 *
 * Runs arbitrary commands in a real node-pty terminal and records ordered raw
 * terminal-stream snapshots. Input and resize actions are event-driven: their
 * output subscriptions are installed before the action is sent, every wait has
 * a hard deadline, and a resize snapshot is accepted only after a complete
 * DECSET 2026 frame or a declared post-resize marker.
 *
 * Usage:
 *   node grok-neo-drive.mjs --scenario scenario.json
 *   node grok-neo-drive.mjs --self-test
 *
 * Scenario shape:
 * {
 *   "command": "/path/to/cli", "args": ["..."], "env": {"KEY":"value"},
 *   "cwd": "/optional/cwd", "cols": 120, "rows": 36,
 *   "snapshotDir": "/absolute/or/relative/output", "timeoutMs": 5000,
 *   "steps": [
 *     { "type": "wait", "sentinel": "ready", "snapshot": "boot" },
 *     { "type": "input", "text": "hello\\n", "waitFor": "received", "snapshot": "turn" },
 *     { "type": "resize", "after": "received", "cols": 80, "rows": 24,
 *       "snapshot": "narrow", "postResizeMarker": "resized" }
 *   ]
 * }
 */

import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createChecks } from "./lib/common.mjs";

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const DEFAULT_TIMEOUT_MS = 5000;
const require = createRequire(import.meta.url);

/**
 * node-pty's Darwin prebuild ships a small spawn-helper alongside pty.node.
 * Some npm extractors preserve it as 0644; restore its executable bit locally
 * before the first PTY spawn. The dependency remains skill-local.
 */
function ensureNodePtySpawnHelperExecutable() {
	if (process.platform === "win32") return;
	const packagePath = require.resolve("node-pty/package.json");
	const helper = join(dirname(packagePath), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	if (!existsSync(helper)) return;
	const mode = statSync(helper).mode & 0o777;
	if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
}

async function loadNodePty() {
	ensureNodePtySpawnHelperExecutable();
	const mod = await import("node-pty");
	return mod.default ?? mod;
}

class DriveError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = "DriveError";
		Object.assign(this, details);
	}
}

function boundedTimeout(label, timeoutMs) {
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new DriveError(`${label}: timeout must be a positive integer, got ${timeoutMs}`);
	}
	return timeoutMs;
}

function dispose(subscription) {
	try {
		if (typeof subscription === "function") subscription();
		else subscription?.dispose?.();
	} catch {
		// Listener cleanup must not hide the primary scenario result.
	}
}

/** Append-only raw stream with event-based, bounded content waiters. */
class RawStream {
	constructor(term) {
		this.raw = "";
		this.listeners = new Set();
		this.exit = null;
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.dataSubscription = term.onData((chunk) => {
			this.raw += chunk;
			for (const listener of [...this.listeners]) listener();
		});
		this.exitSubscription = term.onExit((event) => {
			this.exit = event;
			this.resolveExit(event);
			for (const listener of [...this.listeners]) listener();
		});
	}

	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close() {
		dispose(this.dataSubscription);
		dispose(this.exitSubscription);
		this.listeners.clear();
	}
}

function waitForContent(stream, sentinel, { timeoutMs, label, from = 0 } = {}) {
	if (typeof sentinel !== "string" || sentinel.length === 0) {
		throw new DriveError(`${label ?? "content wait"}: sentinel must be a non-empty string`);
	}
	const limit = boundedTimeout(label ?? `sentinel ${JSON.stringify(sentinel)}`, timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const start = Math.max(0, from);
	return new Promise((resolveWait, rejectWait) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			fn(value);
		};
		const inspect = () => {
			const index = stream.raw.indexOf(sentinel, start);
			if (index >= 0) {
				finish(resolveWait, { kind: "sentinel", sentinel, index, rawLength: stream.raw.length });
				return;
			}
			if (stream.exit) {
				finish(
					rejectWait,
					new DriveError(`${label ?? "content wait"}: PTY exited before sentinel ${JSON.stringify(sentinel)}`, {
						exit: stream.exit,
						raw: stream.raw,
					}),
				);
			}
		};
		const timer = setTimeout(() => {
			finish(
				rejectWait,
				new DriveError(`${label ?? "content wait"}: timed out after ${limit}ms waiting for sentinel ${JSON.stringify(sentinel)}`, {
					raw: stream.raw,
				}),
			);
		}, limit);
		// Subscribe before inspecting so callers can safely trigger an input next.
		unsubscribe = stream.onChange(inspect);
		inspect();
	});
}

/**
 * Wait for a complete synchronized frame written after `from`, or a deliberate
 * post-resize marker. This is event-driven: timeout only bounds failure.
 */
function waitForPostResize(stream, { timeoutMs, label, from, marker } = {}) {
	const limit = boundedTimeout(label ?? "post-resize frame", timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const start = Number.isInteger(from) ? from : stream.raw.length;
	if (marker !== undefined && (typeof marker !== "string" || marker.length === 0)) {
		throw new DriveError(`${label ?? "post-resize frame"}: postResizeMarker must be a non-empty string`);
	}
	return new Promise((resolveWait, rejectWait) => {
		let settled = false;
		let unsubscribe = () => {};
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			fn(value);
		};
		const inspect = () => {
			const afterResize = stream.raw.slice(start);
			const begin = afterResize.indexOf(SYNC_BEGIN);
			const end = begin >= 0 ? afterResize.indexOf(SYNC_END, begin + SYNC_BEGIN.length) : -1;
			if (begin >= 0 && end >= 0) {
				finish(resolveWait, { kind: "synchronized-frame", begin: start + begin, end: start + end + SYNC_END.length, rawLength: stream.raw.length });
				return;
			}
			if (marker) {
				const markerIndex = afterResize.indexOf(marker);
				if (markerIndex >= 0) {
					finish(resolveWait, { kind: "post-resize-marker", marker, index: start + markerIndex, rawLength: stream.raw.length });
					return;
				}
			}
			if (stream.exit) {
				finish(
					rejectWait,
					new DriveError(`${label ?? "post-resize frame"}: PTY exited before a complete synchronized frame${marker ? ` or marker ${JSON.stringify(marker)}` : ""}`, {
						exit: stream.exit,
						raw: stream.raw,
					}),
				);
			}
		};
		const timer = setTimeout(() => {
			finish(
				rejectWait,
				new DriveError(`${label ?? "post-resize frame"}: timed out after ${limit}ms waiting for a complete synchronized frame${marker ? ` or marker ${JSON.stringify(marker)}` : ""}`, {
					raw: stream.raw,
				}),
			);
		}, limit);
		// Installed before term.resize() by runScenario().
		unsubscribe = stream.onChange(inspect);
		inspect();
	});
}

function normalizeScenario(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DriveError("scenario must be an object");
	if (typeof value.command !== "string" || value.command.length === 0) throw new DriveError("scenario.command must be a non-empty string");
	if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) {
		throw new DriveError("scenario.args must be an array of strings");
	}
	if (!Array.isArray(value.steps) || value.steps.length === 0) throw new DriveError("scenario.steps must be a non-empty array");
	const cols = value.cols ?? 120;
	const rows = value.rows ?? 36;
	if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
		throw new DriveError("scenario.cols and scenario.rows must be positive integers");
	}
	const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	boundedTimeout("scenario", timeoutMs);
	return {
		...value,
		args: value.args ?? [],
		cols,
		rows,
		timeoutMs,
		env: value.env ?? {},
		snapshotDir: value.snapshotDir ?? join(process.cwd(), "grok-neo-captures"),
	};
}

function snapshotPath(dir, index, label) {
	const safeLabel = String(label ?? `snapshot-${index}`).replace(/[^A-Za-z0-9._-]+/g, "-");
	return join(dir, `${String(index).padStart(3, "0")}-${safeLabel}.ans`);
}

function writeSnapshot(dir, snapshots, label, stream, stepType) {
	mkdirSync(dir, { recursive: true });
	const path = snapshotPath(dir, snapshots.length + 1, label);
	writeFileSync(path, stream.raw);
	const snapshot = { order: snapshots.length + 1, label: label ?? basename(path, ".ans"), stepType, path, bytes: Buffer.byteLength(stream.raw) };
	snapshots.push(snapshot);
	return snapshot;
}

async function teardownPty(term, stream, timeoutMs) {
	const receipt = { pid: term.pid ?? null, killAttempted: false, alreadyExited: !!stream.exit, exited: false, exitCode: null, signal: null };
	if (!stream.exit) {
		receipt.killAttempted = true;
		try {
			term.kill();
		} catch (error) {
			receipt.killError = error instanceof Error ? error.message : String(error);
		}
	}
	const timeout = boundedTimeout("teardown", timeoutMs);
	const outcome = await Promise.race([
		stream.exitPromise.then((event) => ({ event })),
		new Promise((resolveWait) => setTimeout(() => resolveWait({ timeout: true }), timeout)),
	]);
	if (outcome.timeout) {
		receipt.timeout = true;
	} else {
		receipt.exited = true;
		receipt.exitCode = outcome.event.exitCode ?? null;
		receipt.signal = outcome.event.signal ?? null;
	}
	stream.close();
	return receipt;
}

/**
 * Execute a scenario. The returned report is intentionally plain JSON so a
 * future visual QA lane can persist it next to the ordered .ans snapshots.
 */
export async function runScenario(rawScenario, { ptyModule } = {}) {
	const scenario = normalizeScenario(rawScenario);
	const pty = ptyModule ?? (await loadNodePty());
	const term = pty.spawn(scenario.command, scenario.args, {
		name: scenario.term ?? "xterm-256color",
		cols: scenario.cols,
		rows: scenario.rows,
		cwd: scenario.cwd ?? process.cwd(),
		env: { ...process.env, ...scenario.env },
	});
	const stream = new RawStream(term);
	const snapshots = [];
	const events = [];
	// `after` describes the state produced by the most recent triggering
	// action. Passive `wait` snapshots must never widen this causal boundary:
	// otherwise a later resize can reuse a marker from an older terminal state.
	let stateStart = 0;
	let cleanupReceipt;
	let primaryError;
	try {
		for (let index = 0; index < scenario.steps.length; index += 1) {
			const step = scenario.steps[index];
			if (!step || typeof step !== "object") throw new DriveError(`step ${index + 1} must be an object`);
			const timeoutMs = step.timeoutMs ?? scenario.timeoutMs;
			const label = `step ${index + 1} (${step.type ?? "unknown"})`;
			if (step.type === "wait") {
				const observed = await waitForContent(stream, step.sentinel, { timeoutMs, label });
				events.push({ order: events.length + 1, type: "wait", observed });
				if (step.snapshot) writeSnapshot(scenario.snapshotDir, snapshots, step.snapshot, stream, step.type);
				continue;
			}
			if (step.type === "input") {
				if (typeof step.text !== "string") throw new DriveError(`${label}: text must be a string`);
				const actionStart = stream.raw.length;
				// The waiter is constructed before write(), preventing fast output races.
				const wait = waitForContent(stream, step.waitFor, { timeoutMs, label, from: actionStart });
				term.write(step.text);
				const observed = await wait;
				stateStart = actionStart;
				events.push({ order: events.length + 1, type: "input", text: step.text, stateStart, observed });
				if (step.snapshot) writeSnapshot(scenario.snapshotDir, snapshots, step.snapshot, stream, step.type);
				continue;
			}
			if (step.type === "resize") {
				if (typeof step.after !== "string" || step.after.length === 0) throw new DriveError(`${label}: after must be a prior-state sentinel`);
				if (!Number.isInteger(step.cols) || step.cols <= 0 || !Number.isInteger(step.rows) || step.rows <= 0) {
					throw new DriveError(`${label}: cols and rows must be positive integers`);
				}
				// A resize is causally gated on content proving the preceding state.
				// Scope the sentinel to output from the action that created that state;
				// never search the accumulated stream from offset zero.
				const priorStateStart = stateStart;
				const prior = await waitForContent(stream, step.after, { timeoutMs, label: `${label} prior-state sentinel`, from: priorStateStart });
				const beforeResize = stream.raw.length;
				// Subscribe before resize(), then accept only a complete next frame/marker.
				const postResize = waitForPostResize(stream, {
					timeoutMs,
					label: `${label} post-resize snapshot`,
					from: beforeResize,
					marker: step.postResizeMarker,
				});
				term.resize(step.cols, step.rows);
				const observed = await postResize;
				stateStart = beforeResize;
				events.push({ order: events.length + 1, type: "resize", cols: step.cols, rows: step.rows, priorStateStart, prior, observed });
				if (step.snapshot) writeSnapshot(scenario.snapshotDir, snapshots, step.snapshot, stream, step.type);
				continue;
			}
			throw new DriveError(`${label}: unsupported type; expected wait, input, or resize`);
		}
	} catch (error) {
		primaryError = error;
	} finally {
		cleanupReceipt = await teardownPty(term, stream, Math.min(scenario.timeoutMs, DEFAULT_TIMEOUT_MS));
	}
	if (primaryError) {
		primaryError.cleanupReceipt = cleanupReceipt;
		throw primaryError;
	}
	return { command: scenario.command, args: scenario.args, snapshots, events, cleanupReceipt, rawBytes: Buffer.byteLength(stream.raw) };
}

function fixtureSource() {
	return String.raw`
const begin = "\x1b[?2026h";
const end = "\x1b[?2026l";
process.stdout.write("FIXTURE_READY\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.includes("GO")) process.stdout.write(begin + "INPUT_ACCEPTED\n" + end);
});
let resizeCount = 0;
process.on("SIGWINCH", () => process.stdout.write(begin + "RESIZE_FRAME_" + ++resizeCount + "\n" + end));
`;
}

async function selfTest() {
	const checks = createChecks("grok-neo-drive.mjs --self-test");
	const root = mkdtempSync(join(tmpdir(), "grok-neo-drive-"));
	const captures = join(root, "captures");
	try {
		const scenario = {
			command: process.execPath,
			args: ["-e", fixtureSource()],
			cols: 120,
			rows: 36,
			timeoutMs: 3000,
			snapshotDir: captures,
			steps: [
				{ type: "wait", sentinel: "FIXTURE_READY", snapshot: "boot" },
				{ type: "input", text: "GO\n", waitFor: "INPUT_ACCEPTED", snapshot: "after-input" },
				{ type: "resize", after: "INPUT_ACCEPTED", cols: 80, rows: 24, snapshot: "after-resize" },
			],
		};
		const report = await runScenario(scenario);
		const input = report.events.find((event) => event.type === "input");
		const resize = report.events.find((event) => event.type === "resize");
		checks.ok("input sentinel subscription observes the triggered response", input?.observed?.sentinel === "INPUT_ACCEPTED");
		checks.ok(
			"resize is gated by a prior content sentinel and snapshot follows a complete synchronized frame",
			resize?.prior?.sentinel === "INPUT_ACCEPTED" && resize?.observed?.kind === "synchronized-frame",
			resize ? `post-resize=${resize.observed.kind}` : "resize event missing",
		);
		const snapshotLabels = report.snapshots.map((snapshot) => snapshot.label);
		checks.ok(
			"ordered raw-stream snapshots are written as .ans files",
			JSON.stringify(snapshotLabels) === JSON.stringify(["boot", "after-input", "after-resize"]) &&
				report.snapshots.every((snapshot) => snapshot.path.endsWith(".ans") && readFileSync(snapshot.path, "utf8").length > 0),
			JSON.stringify(snapshotLabels),
		);
		checks.ok(
			"teardown receipt confirms the PTY exited",
			report.cleanupReceipt.killAttempted && report.cleanupReceipt.exited && !report.cleanupReceipt.timeout,
			JSON.stringify(report.cleanupReceipt),
		);

		const twoResizeReport = await runScenario({
			...scenario,
			snapshotDir: join(root, "two-resize-captures"),
			steps: [
				{ type: "wait", sentinel: "FIXTURE_READY" },
				{ type: "input", text: "GO\n", waitFor: "INPUT_ACCEPTED" },
				{ type: "resize", after: "INPUT_ACCEPTED", cols: 80, rows: 24 },
				{ type: "resize", after: "RESIZE_FRAME_1", cols: 120, rows: 36 },
			],
		});
		const twoResizes = twoResizeReport.events.filter((event) => event.type === "resize");
		checks.ok(
			"second resize consumes a fresh marker from the first resize state",
			twoResizes.length === 2 &&
				twoResizes[0].prior.sentinel === "INPUT_ACCEPTED" &&
				twoResizes[1].prior.sentinel === "RESIZE_FRAME_1" &&
				twoResizes[1].prior.index > twoResizes[0].prior.index,
			JSON.stringify(twoResizes.map((event) => ({ sentinel: event.prior.sentinel, index: event.prior.index, from: event.priorStateStart }))),
		);

		// Regression proof: a second resize cannot reuse a marker emitted only
		// before the first resize. The fixture emits a complete frame on every
		// resize, so this specifically catches stale-sentinel false passes.
		let staleStateFailure;
		try {
			await runScenario({
				...scenario,
				snapshotDir: join(root, "stale-state-captures"),
				steps: [
					{ type: "wait", sentinel: "FIXTURE_READY" },
					{ type: "input", text: "GO\n", waitFor: "INPUT_ACCEPTED" },
					{ type: "resize", after: "INPUT_ACCEPTED", cols: 80, rows: 24 },
					{ type: "resize", after: "INPUT_ACCEPTED", cols: 120, rows: 36, timeoutMs: 150 },
				],
			});
		} catch (error) {
			staleStateFailure = error;
		}
		checks.ok(
			"stale pre-resize marker cannot gate a second resize",
			staleStateFailure instanceof DriveError && /timed out/.test(staleStateFailure.message) && staleStateFailure.cleanupReceipt?.exited === true,
			staleStateFailure ? staleStateFailure.message : "second resize unexpectedly accepted a stale marker",
		);

		// Mutation proof: replacing the required input sentinel must turn the run
		// into a bounded failure. If sentinel matching regresses into an unconditional
		// success, this check fails instead of masking the defect.
		let mutationFailure;
		try {
			await runScenario({
				...scenario,
				snapshotDir: join(root, "mutated-captures"),
				steps: [
					{ type: "wait", sentinel: "FIXTURE_READY" },
					{ type: "input", text: "GO\n", waitFor: "MUTATED_SENTINEL_MUST_NOT_MATCH", timeoutMs: 150 },
				],
			});
		} catch (error) {
			mutationFailure = error;
		}
		checks.ok(
			"sentinel mutation proof fails loudly and still tears down",
			mutationFailure instanceof DriveError && /timed out/.test(mutationFailure.message) && mutationFailure.cleanupReceipt?.exited === true,
			mutationFailure ? mutationFailure.message : "mutated sentinel unexpectedly passed",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	process.exit(checks.finish() ? 0 : 1);
}

async function main() {
	const [mode, scenarioPath] = process.argv.slice(2);
	if (mode === "--self-test") return selfTest();
	if (mode === "--scenario" && scenarioPath && process.argv.length === 4) {
		const path = resolve(scenarioPath);
		const scenario = JSON.parse(readFileSync(path, "utf8"));
		const report = await runScenario(scenario);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.stdout.write(`CLEANUP_RECEIPT ${JSON.stringify(report.cleanupReceipt)}\n`);
		return;
	}
	process.stdout.write(
		[
			"grok-neo PTY capture driver",
			"  node grok-neo-drive.mjs --scenario scenario.json",
			"  node grok-neo-drive.mjs --self-test",
			"",
		].join("\n"),
	);
	process.exitCode = 2;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		if (error?.cleanupReceipt) process.stderr.write(`CLEANUP_RECEIPT ${JSON.stringify(error.cleanupReceipt)}\n`);
		process.exit(1);
	});
}

export { DriveError, SYNC_BEGIN, SYNC_END, waitForContent, waitForPostResize };
