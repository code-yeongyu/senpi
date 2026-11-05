// Screen model and startup readiness for the /resume PTY scenario (senpi#5291).
//
// The `senpi v…` header is painted before startup finishes. Until it does, the composer takes text but a submit only
// reports "Startup is still in progress" (interactive-mode.ts handleStartupSubmit) and the text stays in the editor.
// The real submit handler is installed together with the key handlers, whose editor onChange recolors the composer
// border when the text starts with `!` (bash mode). So readiness is observed the way EQ.tui does it
// (equivalence-tui-capture.mjs ready()): type `!` plus a fence character, compare the border with the idle border,
// erase both, and repeat until the recolor shows. Every step waits on the rendered screen; nothing sleeps.
import { createRequire } from "node:module";
import { join } from "node:path";
import { repoRoot } from "./common.mjs";

const FRAME_BEGIN = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
const PROMPT = "\u276f";
const FENCE = "z";
const ERASE = "\x7f";

const loadTerminal = () => createRequire(join(repoRoot(), "package.json"))("@xterm/headless").Terminal;

/**
 * A headless terminal fed from `stream.raw` (the PTY output so far, see tui-resume-pty.mjs attachStream). Waits resolve
 * on the first parsed state that satisfies their predicate, read only at a frame boundary (the renderer wraps each frame
 * in synchronized-output markers), and reject when the PTY exits.
 */
export function createResumeScreen(stream, { cols, rows, Terminal = loadTerminal() }) {
	const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
	const waiters = new Set();
	let fed = 0;
	let pendingWrites = 0;
	let frameOpen = false;
	const settled = () => pendingWrites === 0 && !frameOpen;
	const check = () => {
		if (!settled()) return;
		for (const waiter of [...waiters]) if (waiter.predicate()) waiter.done();
	};
	const feed = () => {
		if (stream.raw.length > fed) {
			const chunk = stream.raw.slice(fed);
			fed = stream.raw.length;
			const begin = stream.raw.lastIndexOf(FRAME_BEGIN);
			const open = begin > stream.raw.lastIndexOf(FRAME_END);
			pendingWrites += 1;
			term.write(chunk, () => {
				pendingWrites -= 1;
				frameOpen = open;
				check();
			});
		}
		if (stream.exit) for (const waiter of [...waiters]) waiter.fail(new Error(`PTY exited while waiting for ${waiter.label}`));
	};
	stream.listeners.add(feed);

	const screen = {
		/** The visible rows, right-trimmed. */
		rows() {
			const buffer = term.buffer.active;
			const out = [];
			for (let row = buffer.viewportY; row < buffer.viewportY + rows; row++)
				out.push(buffer.getLine(row)?.translateToString(true) ?? "");
			return out;
		},
		/** The composer row: the last visible row that starts with the prompt glyph. */
		editor: () => screen.rows().findLast((row) => row.startsWith(PROMPT)),
		/** Foreground/background color of every cell in the row above the composer (its top border). */
		borderStyle() {
			const buffer = term.buffer.active;
			const index = screen.rows().findLastIndex((row) => row.startsWith(PROMPT));
			const line = buffer.getLine(buffer.viewportY + index - 1);
			if (index < 1 || !line) return "";
			const cell = buffer.getNullCell();
			const runs = [];
			for (let col = 0; col < cols; col++) {
				line.getCell(col, cell);
				runs.push(`${cell.getFgColorMode()}/${cell.getFgColor()} ${cell.getBgColorMode()}/${cell.getBgColor()}`);
			}
			return runs.join(";");
		},
		waitFor(predicate, label, timeoutMs) {
			return new Promise((resolve, reject) => {
				const waiter = {
					label,
					predicate: () => predicate(screen),
					done: () => {
						clearTimeout(timer);
						waiters.delete(waiter);
						resolve();
					},
					fail: (error) => {
						clearTimeout(timer);
						waiters.delete(waiter);
						reject(error);
					},
				};
				const timer = setTimeout(
					() => waiter.fail(new Error(`${label} timed out after ${timeoutMs}ms; screen:\n${screen.rows().join("\n")}`)),
					timeoutMs,
				);
				waiters.add(waiter);
				feed();
				if (settled() && waiter.predicate()) waiter.done();
			});
		},
		dispose() {
			stream.listeners.delete(feed);
			for (const waiter of [...waiters]) waiter.fail(new Error(`screen disposed while waiting for ${waiter.label}`));
			term.dispose();
		},
	};
	return screen;
}

/** Resolve once the TUI accepts a submit (startup finished); returns how many readiness probes it took. */
export async function waitForStartupComplete(term, screen, { timeoutMs }) {
	const deadline = Date.now() + timeoutMs;
	const remaining = () => Math.max(1, deadline - Date.now());
	await screen.waitFor((s) => s.editor() !== undefined, "composer", remaining());
	for (let probes = 1; Date.now() < deadline; probes++) {
		const idleBorder = screen.borderStyle();
		term.write(`!${FENCE}`);
		await screen.waitFor((s) => s.editor()?.trimEnd() === `${PROMPT} !${FENCE}`, "readiness probe typed", remaining());
		const probeBorder = screen.borderStyle();
		term.write(ERASE + ERASE);
		await screen.waitFor((s) => s.editor()?.trimEnd() === PROMPT, "readiness probe erased", remaining());
		if (probeBorder !== idleBorder) return probes;
	}
	throw new Error(`TUI startup did not finish within ${timeoutMs}ms`);
}
