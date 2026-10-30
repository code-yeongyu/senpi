// EQ.tui capture (plan P0-05c, §6.2 O8 "TUI captures"): run the real interactive CLI in a pseudo-terminal, model the
// screen with @xterm/headless, and capture the whole rendered buffer (scrollback + screen) as text plus per-cell style
// runs at settled checkpoints.
//
// - The PTY is Bun's (`Bun.spawn({ terminal })`): this file re-executes itself under Bun with `--pty-relay` and relays
//   bytes between its stdio and the terminal, so the driver keeps running on Node and needs no native addon.
// - Nothing is sampled on a timer. A wait resolves on the first screen state that satisfies its predicate, evaluated
//   after each parsed write. A checkpoint is taken only once the TUI is quiescent: the case's predicate holds, then a
//   render fence (type one character, see it in the editor, erase it, see it gone) proves every earlier render landed.
// - Normalization is the §6.2 rule set (observe.mjs's normalizer: run-scoped roots, host facts, ids, timestamps) plus the
//   one TUI form of "durations are dropped": a rendered duration (`0.0s`, `1s`, `250ms`) becomes `<duration>`. Styles
//   are compared as rendered; nothing else is masked.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childRuntime, cliEntry, repoRoot, resolveBun, track } from "./common.mjs";

const SELF = fileURLToPath(import.meta.url);
const RELAY_FLAG = "--pty-relay";
const TUI_COLS = 100;
const TUI_ROWS = 30;
const WAIT_TIMEOUT_MS = 120_000;
/** A loaded host can hold a Bun child's first file opens for minutes (case-run.mjs OPEN_TIMEOUT_MS). */
const BOOT_TIMEOUT_MS = 300_000;
/** A rendered duration: `0.0s`, `250ms`, `1s`, `2m 00s`, `1h 02m 03s` (working-status.ts, tps.ts). */
const RENDERED_DURATION = /\b(?:\d+h )?(?:\d+m )?\d+(?:\.\d+)?(?:ms|s)\b/g;
/** Synchronized-output markers that open and close each rendered frame (`\x1b[?2026h` / `\x1b[?2026l`). */
const FRAME_BEGIN = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
/**
 * A live elapsed-time row (`Running \u2026 (<duration>)`, `Working (<duration> \u2022 \u2026)`): its shimmer is a function of the
 * elapsed milliseconds (working-status.ts), so its style runs are a rendered duration too and are dropped; its text stays.
 */
const ELAPSED_ROW = "(<duration>";
export const ELAPSED_ROW_STYLES = ["<elapsed-time row>"];
const FENCE = "z";

const loadTerminal = () => createRequire(join(repoRoot(), "package.json"))("@xterm/headless").Terminal;

/** The CLI argv on the driver's child runtime (Bun or the compiled binary; the TUI surface has no Node child). */
function cliArgv(args) {
	const runtime = childRuntime();
	if (runtime.kind === "binary") return [runtime.command, ...args];
	if (runtime.kind === "bun") return [runtime.command, cliEntry(repoRoot()), ...args];
	throw new Error(`EQ.tui runs the CLI on Bun or the compiled binary, not ${runtime.label}`);
}

/** The session file the TUI persisted under the sandbox's session dir (exactly one per case run). */
export function findSessionFile(sessionDir) {
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(dir, entry.name));
			else if (entry.name.endsWith(".jsonl")) found.push(join(dir, entry.name));
		}
	};
	walk(sessionDir);
	if (found.length !== 1) throw new Error(`expected one session file under the sandbox, found ${found.length}`);
	return found[0];
}

/** Text of every buffer row (scrollback + screen), right-trimmed, without trailing empty rows. */
function bufferLines(term) {
	const buffer = term.buffer.active;
	const lines = [];
	for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row).translateToString(true));
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lines;
}

/** Per-row style runs `<from>-<to> <fg mode>/<fg> <bg mode>/<bg> <flags>` over the cells that carry a glyph. */
function bufferStyles(term, rowCount) {
	const buffer = term.buffer.active;
	const cell = buffer.getNullCell();
	const styles = [];
	for (let row = 0; row < rowCount; row++) {
		const line = buffer.getLine(row);
		const runs = [];
		let current;
		for (let col = 0; col < term.cols; col++) {
			line.getCell(col, cell);
			const flags = [
				cell.isBold(),
				cell.isDim(),
				cell.isItalic(),
				cell.isUnderline(),
				cell.isInverse(),
				cell.isStrikethrough(),
			]
				.map((on) => (on ? 1 : 0))
				.join("");
			const key = `${cell.getFgColorMode()}/${cell.getFgColor()} ${cell.getBgColorMode()}/${cell.getBgColor()} ${flags}`;
			if (current?.key === key) current.to = col;
			else runs.push((current = { from: col, to: col, key }));
		}
		styles.push(runs.map((run) => `${run.from}-${run.to} ${run.key}`));
	}
	return styles;
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";

/**
 * Start the interactive CLI for this case run in a Bun PTY. `run` is a case-run.mjs run (sandbox, fake server, env,
 * args). Returns a handle the case drives; checkpoints land in `run.tuiCheckpoints`.
 */
export function startTui(run, { resume = false } = {}) {
	const Terminal = loadTerminal();
	const term = new Terminal({ cols: TUI_COLS, rows: TUI_ROWS, scrollback: 10_000, allowProposedApi: true });
	const args = ["--no-context-files", ...run.args, ...(resume ? ["--session", run.sessionFile] : [])];
	const relay = spawn(resolveBun().command, [SELF, RELAY_FLAG, String(TUI_COLS), String(TUI_ROWS), ...cliArgv(args)], {
		cwd: run.box.cwd,
		env: run.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	track(relay);
	const waiters = new Set();
	const frames = [];
	let stderr = "";
	// The renderer wraps every frame in synchronized-output markers (packages/tui/src/tui.ts FRAME_BEGIN/FRAME_END). A
	// chunk can end inside a frame, so screen state is read only at a frame boundary: never a half-painted frame.
	let frameOpen = false;
	let scanTail = "";
	const check = () => {
		if (frameOpen) return;
		const lines = bufferLines(term);
		for (const waiter of [...waiters]) if (waiter.predicate(lines)) waiter.done(lines);
	};
	relay.stdout.on("data", (chunk) => {
		frames.push({ at: performance.now(), bytes: chunk.length });
		const text = scanTail + chunk.toString("latin1");
		const begin = text.lastIndexOf(FRAME_BEGIN);
		const end = text.lastIndexOf(FRAME_END);
		const open = begin === end ? frameOpen : begin > end;
		scanTail = text.slice(-(FRAME_BEGIN.length - 1));
		term.write(chunk, () => {
			frameOpen = open;
			check();
		});
	});
	// Answer the CLI's terminal queries (device attributes, colors, cursor position) as a real terminal does: the TUI
	// picks its theme and color depth from those answers, and without them it renders in a reduced palette.
	term.onData((reply) => relay.stdin.write(reply));
	relay.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exited = new Promise((resolve) => relay.once("close", (code, signal) => resolve(code ?? signal)));
	exited.then(() => {
		for (const waiter of [...waiters])
			waiter.fail(new Error(`TUI exited while waiting for ${waiter.label} (stderr: ${stderr.slice(-400)})`));
	});
	const tui = {
		/** Raw output chunk arrival times (for EQ.perf's frame time); never part of the equality. */
		frames,
		exited,
		lines: () => bufferLines(term),
		/** The visible screen rows (the last TUI_ROWS rows of the buffer). */
		screen: () => {
			const buffer = term.buffer.active;
			const rows = [];
			for (let row = buffer.viewportY; row < buffer.viewportY + TUI_ROWS; row++)
				rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
			return rows;
		},
		waitFor(predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
			return new Promise((resolve, reject) => {
				const waiter = {
					label,
					predicate: () => predicate(tui),
					done: (lines) => {
						clearTimeout(timer);
						waiters.delete(waiter);
						resolve(lines);
					},
					fail: (error) => {
						clearTimeout(timer);
						waiters.delete(waiter);
						reject(error);
					},
				};
				const timer = setTimeout(
					() =>
						waiter.fail(
							new Error(
								`timed out waiting for ${label} (predicate now ${waiter.predicate()}, ${frames.length} chunks); screen:\n${tui.screen().join("\n")}`,
							),
						),
					timeoutMs,
				);
				waiters.add(waiter);
				if (!frameOpen && waiter.predicate()) waiter.done(bufferLines(term));
			});
		},
		write(bytes) {
			relay.stdin.write(bytes);
		},
		/** The editor row: the screen row the composer prompt glyph starts. */
		editor: () => tui.screen().findLast((row) => row.startsWith("❯")),
		/** Style runs of the screen row `offset` rows from the editor row (-1: the border above it). */
		editorStyle(offset) {
			const buffer = term.buffer.active;
			const rows = tui.screen();
			const row = buffer.viewportY + rows.findLastIndex((text) => text.startsWith("\u276f")) + offset;
			return bufferStyles(term, row + 1)[row].join(";");
		},
		/**
		 * Wait until startup has finished. Before it does, the composer takes text but a submit only reports "Startup is
		 * still in progress" (interactive-mode.ts handleStartupSubmit). The handlers installed at the end of startup
		 * recolor the composer border when its text starts with `!` (bash mode): type `!` plus a fence character, compare
		 * the border with the idle border, erase both, and repeat until the recolor shows. Every step waits on the screen.
		 */
		async ready() {
			await tui.waitFor((t) => t.editor() !== undefined, "composer", BOOT_TIMEOUT_MS);
			const deadline = Date.now() + BOOT_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const idleBorder = tui.editorStyle(-1);
				tui.write(`!${FENCE}`);
				await tui.waitFor((t) => t.editor()?.trimEnd() === `\u276f !${FENCE}`, "readiness probe typed");
				const probeBorder = tui.editorStyle(-1);
				tui.write("\x7f\x7f");
				await tui.waitFor((t) => t.editor()?.trimEnd() === "\u276f", "readiness probe erased");
				if (probeBorder !== idleBorder) return;
			}
			throw new Error("the TUI never finished startup");
		},
		/** Render fence: every render queued before it has reached the terminal once the fence character is erased. */
		async fence() {
			tui.write(FENCE);
			await tui.waitFor((t) => t.editor()?.trimEnd() === `❯ ${FENCE}`, "fence typed");
			tui.write("\x7f");
			await tui.waitFor((t) => t.editor()?.trimEnd() === "❯", "fence erased");
		},
		/** Type text into the composer, see it there, then submit it. */
		async submit(text) {
			tui.write(text);
			await tui.waitFor((t) => t.editor()?.trimEnd() === `❯ ${text}`, `typed ${JSON.stringify(text)}`);
			tui.write("\r");
		},
		/** Render fence for a focused selector: move the selection down and back up, seeing `marker` leave and return. */
		async selectorFence(marker) {
			tui.write(DOWN);
			await tui.waitFor((t) => !t.screen().some((row) => row.includes(marker)), "selector moved");
			tui.write(UP);
			await tui.waitFor((t) => t.screen().some((row) => row.includes(marker)), "selector restored");
		},
		/** Wait for `predicate`, fence (the composer fence unless `fence` is given), then record the whole buffer. */
		async checkpoint(label, predicate, fence = () => tui.fence()) {
			await tui.waitFor(predicate, `checkpoint ${label}`);
			await fence();
			const lines = bufferLines(term);
			(run.tuiCheckpoints ??= []).push({ label, lines, styles: bufferStyles(term, lines.length) });
		},
		/** Crash the CLI (SIGKILL through the relay) and wait for the relay to exit. */
		async kill() {
			relay.kill("SIGUSR2");
			await exited;
		},
		/** End the session: the relay terminates the CLI and exits. */
		async stop() {
			if (relay.exitCode === null && relay.signalCode === null) relay.stdin.end();
			await exited;
		},
	};
	run.cleanups.push(() => tui.stop());
	return tui;
}

/** True when the TUI shows no working indicator (the turn is idle). */
export const idle = (tui) => !tui.screen().some((row) => row.includes("to interrupt)"));

/** A screen line with every rendered duration replaced by `<duration>` (§6.2: durations are dropped). */
export const dropRenderedDurations = (line) => line.replace(RENDERED_DURATION, "<duration>");

/** The case's checkpoints, normalized by `normalize` (the §6.2 rule set), with rendered durations dropped. */
export function tuiObservation(run, normalize) {
	const checkpoints = (run.tuiCheckpoints ?? []).map(({ label, lines, styles }) => {
		const shown = lines.map(dropRenderedDurations);
		return {
			label,
			lines: shown,
			styles: styles.map((runs, row) => (shown[row]?.includes(ELAPSED_ROW) ? ELAPSED_ROW_STYLES : runs)),
		};
	});
	return normalize({ tui: checkpoints });
}

/** Relay mode (under Bun): run argv in a PTY, pipe its output to stdout and stdin to it. */
async function relayMain([cols, rows, ...argv]) {
	const proc = Bun.spawn(argv, {
		cwd: process.cwd(),
		env: process.env,
		terminal: { cols: Number(cols), rows: Number(rows), data: (_terminal, data) => process.stdout.write(data) },
	});
	process.stdin.on("data", (data) => proc.terminal.write(data));
	process.stdin.on("end", () => proc.kill("SIGTERM"));
	process.on("SIGTERM", () => proc.kill("SIGTERM"));
	process.on("SIGUSR2", () => proc.kill("SIGKILL"));
	const code = await proc.exited;
	process.exit(code ?? 0);
}

if (process.argv[2] === RELAY_FLAG && process.argv[1] === SELF) {
	relayMain(process.argv.slice(3)).catch((error) => {
		process.stderr.write(`pty relay: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}

export const tuiGoldenDir = (platform) =>
	join(dirname(SELF), "..", "..", "scenarios", "fused-equivalence", "golden-tui", platform);

/** The baseline manifest's hash of the TUI capture and its drives (a change to either invalidates the TUI goldens). */
export function tuiCaptureHash() {
	const hash = createHash("sha256");
	for (const name of ["equivalence-tui-capture.mjs", "equivalence-tui-cases.mjs"])
		hash
			.update(name)
			.update("\0")
			.update(readFileSync(join(dirname(SELF), name)))
			.update("\0");
	return `sha256:${hash.digest("hex")}`;
}
