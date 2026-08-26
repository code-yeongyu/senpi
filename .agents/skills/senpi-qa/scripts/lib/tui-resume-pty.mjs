import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { cliEntry, stripAnsi, tsxEntry } from "./common.mjs";
import {
	BOOT_TIMEOUT_MS,
	COLS,
	FINAL_MARKER,
	FIRST_MARKER,
	HYDRATE_TIMEOUT_MS,
	ROWS,
	SELECTOR_TIMEOUT_MS,
	TUI_ARGS,
} from "./tui-resume-args.mjs";

const require = createRequire(import.meta.url);

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

function attachStream(term) {
	const stream = {
		raw: "",
		exit: null,
		listeners: new Set(),
		exitPromise: null,
		resolveExit: null,
	};
	stream.exitPromise = new Promise((resolve) => {
		stream.resolveExit = resolve;
	});
	term.onData((chunk) => {
		stream.raw += chunk;
		for (const listener of [...stream.listeners]) listener();
	});
	term.onExit((event) => {
		stream.exit = event;
		stream.resolveExit(event);
		for (const listener of [...stream.listeners]) listener();
	});
	return stream;
}

function waitUntil(stream, predicate, { timeoutMs, label }) {
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`${label}: timeout must be a positive integer`);
	return new Promise((resolve, reject) => {
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
			if (predicate(stream.raw)) {
				finish(resolve, { rawLength: stream.raw.length });
				return;
			}
			if (stream.exit) {
				finish(reject, new Error(`${label}: PTY exited before predicate matched`));
			}
		};
		const timer = setTimeout(() => finish(reject, new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		unsubscribe = () => stream.listeners.delete(inspect);
		stream.listeners.add(inspect);
		inspect();
	});
}

function waitForText(stream, needle, options) {
	return waitUntil(stream, (raw) => stripAnsi(raw).includes(needle), options);
}

function recordAction(actions, type, detail) {
	actions.push({ t: new Date().toISOString(), type, ...detail });
}

export async function spawnResumeTui({ root, cwd, env }) {
	const pty = await loadNodePty();
	const term = pty.spawn(
		process.execPath,
		[tsxEntry(root), "--tsconfig", join(root, "tsconfig.json"), cliEntry(root), ...TUI_ARGS],
		{ name: "xterm-256color", cols: COLS, rows: ROWS, cwd, env },
	);
	return { term, stream: attachStream(term) };
}

export async function driveResume(term, stream, { messages, actions }) {
	await waitForText(stream, "senpi v", { timeoutMs: BOOT_TIMEOUT_MS, label: "TUI boot" });
	recordAction(actions, "boot", { sentinel: "senpi v" });

	const selectorWait = waitUntil(
		stream,
		(raw) => {
			const text = stripAnsi(raw);
			return text.includes("Resume Session") && text.includes(FIRST_MARKER);
		},
		{ timeoutMs: SELECTOR_TIMEOUT_MS, label: "/resume selector with latest session" },
	);
	term.write("/resume\r");
	recordAction(actions, "input", { text: "/resume", key: "Enter" });
	await selectorWait;
	recordAction(actions, "wait", { sentinel: "Resume Session", marker: FIRST_MARKER });

	const submitOffset = stream.raw.length;
	const submitStarted = performance.now();
	const finalWait = waitUntil(
		stream,
		(raw) => stripAnsi(raw.slice(submitOffset)).includes(FINAL_MARKER),
		{ timeoutMs: HYDRATE_TIMEOUT_MS, label: "first final marker after submit" },
	);
	term.write("\r");
	recordAction(actions, "input", { text: "", key: "Enter", select: "latest" });
	await finalWait;
	const commandSubmitToFirstFinalMarkerMs = performance.now() - submitStarted;
	await waitUntil(
		stream,
		(raw) => {
			const text = stripAnsi(raw);
			return text.includes(FIRST_MARKER) && text.includes(FINAL_MARKER);
		},
		{ timeoutMs: HYDRATE_TIMEOUT_MS, label: "first and final markers in raw stream" },
	);
	const plain = stripAnsi(stream.raw);
	const timing = {
		commandSubmitToFirstFinalMarkerMs,
		firstMarkerIndex: plain.indexOf(FIRST_MARKER),
		finalMarkerIndex: plain.indexOf(FINAL_MARKER),
		submitOffset,
		messages,
	};
	recordAction(actions, "timing", timing);
	return timing;
}
