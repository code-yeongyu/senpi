#!/usr/bin/env node
// xterm-render.mjs — the TUI evidence harness CORE.
//
// It is the mandatory renderer behind the EVIDENCE FORMAT RULE: every
// TUI-visual claim is proven against a TRIPLET —
//   (1) the raw capture `.ans` (tmux capture-pane -e / node-pty),
//   (2) a self-contained HTML review page rendered here through @xterm/headless,
//   (3) the extracted per-cell grid JSON (fg/bg/attrs/glyph per cell).
// ALL visual assertions run against the PARSED CELL GRID produced here, never
// against raw escape strings.
//
// @xterm/headless is root-hoisted (packages/tui devDependency) — this script
// adds no npm dependency of its own.
//
// Modes (first CLI arg):
//   render   <in.ans> --cols N --rows M [--out-json f] [--out-html f] [--title t]
//              Parse an .ans frame into a cell grid; emit grid JSON + HTML page.
//   assert   <grid.json> --spec assertions.json
//              Run grid assertions (cell color / glyph / region) against a grid.
//   replay   <events.json> [--out-json f]
//              Apply ordered write/resize events with retained scrollback and
//              emit a parsed cell grid for each requested snapshot.
//   raw-assert <in.ans> [--expect-clear-replay] [--replay-sentinel text]
//              Check DECSET 2026 balance and (when requested) clear/replay shape.
//   verify-manifest <manifest.json>
//              FAIL when any registered claim is missing frames, missing a
//              triplet leg, or has no grid-based assertion result.
//   self-test
//              Render a fixture, assert a known cell hex+glyph, then prove the
//              harness FAILS loudly on a corrupted fixture; also runs the
//              verify-manifest self-tests (missing frame / missing assertion).
//
// Exit codes: 0 = ok, 1 = assertion/verification failure, 2 = usage/IO error.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// --- @xterm/headless loader (root-hoisted; fail loudly if absent) ----------

async function loadTerminal() {
	try {
		const mod = await import("@xterm/headless");
		// @xterm/headless ships CommonJS; ESM interop exposes it via `default`.
		const Terminal = mod.Terminal ?? mod.default?.Terminal;
		if (typeof Terminal !== "function") {
			throw new Error("@xterm/headless did not export a Terminal constructor");
		}
		return Terminal;
	} catch (err) {
		throw new HarnessError(
			`@xterm/headless is not resolvable (root-hoisted via packages/tui devDependency). ` +
				`Run \`npm ci --ignore-scripts\` at the repo root first. Cause: ${err.message}`,
			2,
		);
	}
}

/** Error carrying a process exit code so callers can propagate it. */
class HarnessError extends Error {
	constructor(message, code) {
		super(message);
		this.name = "HarnessError";
		this.code = code ?? 1;
	}
}

// --- cell grid extraction ---------------------------------------------------

/** Pack an xterm cell color-triple into a `#rrggbb` string, or a tag. */
function colorField(isRGB, isPalette, isDefault, packed) {
	if (isDefault) {
		return { mode: "default", hex: null, index: null };
	}
	if (isRGB) {
		const n = packed >>> 0;
		const hex = `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
		return { mode: "rgb", hex, index: null };
	}
	if (isPalette) {
		return { mode: "palette", hex: null, index: packed };
	}
	// Neither RGB, palette, nor default: treat as default-ish sentinel.
	return { mode: "unknown", hex: null, index: null };
}

/** Coerce xterm's numeric attribute flags to plain booleans. */
function attrFlags(cell) {
	return {
		bold: cell.isBold() !== 0,
		dim: cell.isDim() !== 0,
		italic: cell.isItalic() !== 0,
		underline: cell.isUnderline() !== 0,
		inverse: cell.isInverse() !== 0,
		invisible: cell.isInvisible() !== 0,
		strikethrough: cell.isStrikethrough() !== 0,
	};
}

/**
 * Render an .ans byte string into a structured cell grid.
 * @returns {{cols:number, rows:number, cells:Array<Array<object>>}}
 */
function gridFromTerminal(term) {
	const { cols, rows } = term;
	const buf = term.buffer.active;
	const cells = [];
	const viewportTop = buf.baseY;
	// Reusable cell accessor avoids per-cell allocation in xterm.
	for (let y = 0; y < rows; y += 1) {
		const line = buf.getLine(viewportTop + y);
		const row = [];
		for (let x = 0; x < cols; x += 1) {
			if (!line) {
				row.push(blankCell());
				continue;
			}
			const c = line.getCell(x);
			if (!c) {
				row.push(blankCell());
				continue;
			}
			const chars = c.getChars();
			row.push({
				x,
				y,
				glyph: chars === "" ? " " : chars,
				width: c.getWidth(),
				fg: colorField(c.isFgRGB(), c.isFgPalette(), c.isFgDefault(), c.getFgColor()),
				bg: colorField(c.isBgRGB(), c.isBgPalette(), c.isBgDefault(), c.getBgColor()),
				attrs: attrFlags(c),
			});
		}
		cells.push(row);
	}
	return { cols, rows, cells };
}

async function renderToGrid(ansText, cols, rows) {
	const Terminal = await loadTerminal();
	const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	try {
		await new Promise((res) => term.write(ansText, res));
		return gridFromTerminal(term);
	} finally {
		term.dispose();
	}
}

function blankCell() {
	return {
		x: -1,
		y: -1,
		glyph: " ",
		width: 1,
		fg: { mode: "default", hex: null, index: null },
		bg: { mode: "default", hex: null, index: null },
		attrs: {
			bold: false,
			dim: false,
			italic: false,
			underline: false,
			inverse: false,
			invisible: false,
			strikethrough: false,
		},
	};
}

// --- ordered replay + raw-stream assertions --------------------------------

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
// `TUI.fullRender()` emits clear-screen, cursor-home, then clear-scrollback.
// Keep this in renderer order; do not infer a historical terminal sequence.
const CLEAR_REPLAY_SEQUENCE = ["\x1b[2J", "\x1b[H", "\x1b[3J"];

function positiveInteger(value, label) {
	if (!Number.isInteger(value) || value <= 0) throw new HarnessError(`${label} must be a positive integer`, 2);
	return value;
}

/**
 * Apply a deterministic ordered terminal event list. `scrollback` is explicitly
 * positive: replay QA must retain history rather than mask reflow with the
 * legacy one-screen renderer. A snapshot is a complete, independent cell grid.
 */
async function replayToSnapshots(plan) {
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new HarnessError("replay: event plan must be an object", 2);
	const initialCols = positiveInteger(plan.cols, "replay.cols");
	const initialRows = positiveInteger(plan.rows, "replay.rows");
	const scrollback = positiveInteger(plan.scrollback ?? 1000, "replay.scrollback");
	if (!Array.isArray(plan.events) || plan.events.length === 0) throw new HarnessError("replay.events must be a non-empty array", 2);

	const Terminal = await loadTerminal();
	const term = new Terminal({ cols: initialCols, rows: initialRows, allowProposedApi: true, scrollback });
	const snapshots = [];
	try {
		for (let index = 0; index < plan.events.length; index += 1) {
			const event = plan.events[index];
			if (!event || typeof event !== "object" || Array.isArray(event)) {
				throw new HarnessError(`replay.events[${index}] must be an object`, 2);
			}
			if (event.type === "write") {
				if (typeof event.data !== "string") throw new HarnessError(`replay.events[${index}].data must be a string`, 2);
				await new Promise((res) => term.write(event.data, res));
			} else if (event.type === "resize") {
				term.resize(positiveInteger(event.cols, `replay.events[${index}].cols`), positiveInteger(event.rows, `replay.events[${index}].rows`));
			} else {
				throw new HarnessError(`replay.events[${index}].type must be write or resize`, 2);
			}

			if (event.snapshot) {
				const label = event.snapshot === true ? `event-${index + 1}` : event.snapshot;
				if (typeof label !== "string" || label.length === 0) throw new HarnessError(`replay.events[${index}].snapshot must be true or a non-empty string`, 2);
				snapshots.push({ order: snapshots.length + 1, eventIndex: index, eventType: event.type, label, grid: gridFromTerminal(term) });
			}
		}
		return { initial: { cols: initialCols, rows: initialRows }, scrollback, snapshots };
	} finally {
		term.dispose();
	}
}

function allTokenOffsets(raw, token) {
	const offsets = [];
	for (let at = raw.indexOf(token); at >= 0; at = raw.indexOf(token, at + token.length)) offsets.push(at);
	return offsets;
}

function sequenceOffsets(raw, tokens) {
	const offsets = [];
	let after = 0;
	for (const token of tokens) {
		const offset = raw.indexOf(token, after);
		if (offset < 0) return { pass: false, offsets };
		offsets.push(offset);
		after = offset + token.length;
	}
	return { pass: true, offsets };
}

/** Return complete DECSET 2026 frames without allowing token matches to cross frame boundaries. */
function synchronizedFrames(raw) {
	const frames = [];
	for (let from = 0; ; ) {
		const begin = raw.indexOf(SYNC_BEGIN, from);
		if (begin < 0) break;
		const end = raw.indexOf(SYNC_END, begin + SYNC_BEGIN.length);
		if (end < 0) break;
		const endExclusive = end + SYNC_END.length;
		frames.push({ start: begin, end: endExclusive, data: raw.slice(begin, endExclusive) });
		from = endExclusive;
	}
	return frames;
}

/**
 * Check raw terminal protocol facts before parsing into cells. The DECSET
 * scanner rejects premature ends as well as nonzero final balance. Clear/replay
 * expectations are evaluated inside one complete synchronized frame: a later
 * frame can never lend a cursor-home or replay sentinel to an earlier clear.
 */
function assertRawStream(raw, { expectClearReplay = false, replaySentinel, clearReplaySequence = CLEAR_REPLAY_SEQUENCE } = {}) {
	if (typeof raw !== "string") throw new HarnessError("raw assertion requires a string stream", 2);
	if (replaySentinel !== undefined && (typeof replaySentinel !== "string" || replaySentinel.length === 0)) {
		throw new HarnessError("raw assertion replaySentinel must be a non-empty string", 2);
	}
	if (!Array.isArray(clearReplaySequence) || clearReplaySequence.some((token) => typeof token !== "string" || token.length === 0)) {
		throw new HarnessError("raw assertion clearReplaySequence must be non-empty strings", 2);
	}

	const transitions = [];
	for (const offset of allTokenOffsets(raw, SYNC_BEGIN)) transitions.push({ offset, kind: "begin" });
	for (const offset of allTokenOffsets(raw, SYNC_END)) transitions.push({ offset, kind: "end" });
	transitions.sort((a, b) => a.offset - b.offset);
	let balance = 0;
	let minimumBalance = 0;
	for (const transition of transitions) {
		balance += transition.kind === "begin" ? 1 : -1;
		minimumBalance = Math.min(minimumBalance, balance);
	}
	const decset = {
		begins: transitions.filter((transition) => transition.kind === "begin").length,
		ends: transitions.filter((transition) => transition.kind === "end").length,
		minimumBalance,
		balanced: balance === 0 && minimumBalance >= 0,
	};

	const frameResults = synchronizedFrames(raw).map((frame, index) => {
		const shape = sequenceOffsets(frame.data, clearReplaySequence);
		const finalClearOffset = shape.offsets.at(-1);
		const replayOffset = replaySentinel === undefined ? null : frame.data.indexOf(replaySentinel, (finalClearOffset ?? -1) + 1);
		const replayAfterClear = replaySentinel === undefined ? true : replayOffset >= 0;
		return {
			index,
			start: frame.start,
			end: frame.end,
			offsets: shape.offsets.map((offset) => frame.start + offset),
			shape: shape.pass,
			replayOffset: replayOffset === null || replayOffset < 0 ? null : frame.start + replayOffset,
			replayAfterClear,
			pass: shape.pass && replayAfterClear,
		};
	});
	const matchingFrames = frameResults.filter((frame) => frame.pass).map((frame) => frame.index);
	const clearReplay = {
		required: expectClearReplay,
		sequence: clearReplaySequence,
		replaySentinel: replaySentinel ?? null,
		frameCount: frameResults.length,
		frames: frameResults,
		matchingFrames,
		pass: !expectClearReplay || matchingFrames.length > 0,
	};
	return { pass: decset.balanced && clearReplay.pass, decset, clearReplay };
}

// --- grid queries (assertion helpers) --------------------------------------

/** Return the cell at (x,y), or throw when out of range. */
function cellAt(grid, x, y) {
	if (y < 0 || y >= grid.rows || x < 0 || x >= grid.cols) {
		throw new HarnessError(`cell (${x},${y}) out of range for ${grid.cols}x${grid.rows} grid`, 1);
	}
	return grid.cells[y][x];
}

/** Collect the distinct `#rrggbb` fg/bg hexes present in a region (inclusive). */
function regionHexes(grid, x0, y0, x1, y1) {
	const fg = new Set();
	const bg = new Set();
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			const c = cellAt(grid, x, y);
			if (c.fg.hex) fg.add(c.fg.hex);
			if (c.bg.hex) bg.add(c.bg.hex);
		}
	}
	return { fg: [...fg].sort(), bg: [...bg].sort() };
}

/** True when the region contains NO truecolor (rgb) fg/bg cells. */
function regionHasNoTruecolor(grid, x0, y0, x1, y1) {
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			const c = cellAt(grid, x, y);
			if (c.fg.mode === "rgb" || c.bg.mode === "rgb") return false;
		}
	}
	return true;
}

/** Find the first cell whose glyph equals `glyph`; null when absent. */
function findGlyph(grid, glyph) {
	for (let y = 0; y < grid.rows; y += 1) {
		for (let x = 0; x < grid.cols; x += 1) {
			if (grid.cells[y][x].glyph === glyph) return { x, y };
		}
	}
	return null;
}

/** Find contiguous rendered text in a single terminal row. */
function findText(grid, text) {
	for (let y = 0; y < grid.rows; y += 1) {
		const row = grid.cells[y].map((cell) => cell.glyph).join("");
		const x = row.indexOf(text);
		if (x >= 0) return { x, y };
	}
	return null;
}

/**
 * Execute one assertion object against a grid, returning a result record.
 * Supported assertion kinds:
 *   cell-fg    {x,y,hex}          fg truecolor hex equals
 *   cell-bg    {x,y,hex}          bg truecolor hex equals
 *   cell-glyph {x,y,glyph}        glyph equals
 *   glyph-present {glyph}         glyph appears somewhere
 *   text-present {text}           contiguous rendered text appears in one row
 *   region-fg-subset {x0,y0,x1,y1,palette:[hex...]}  every fg hex ∈ palette
 *   region-bg-subset {x0,y0,x1,y1,palette:[hex...]}  every bg hex ∈ palette
 *   region-no-truecolor {x0,y0,x1,y1}  no rgb cells (256/NO_COLOR proof)
 */
function runAssertion(grid, a) {
	const base = { id: a.id ?? null, kind: a.kind };
	try {
		switch (a.kind) {
			case "cell-fg": {
				const c = cellAt(grid, a.x, a.y);
				const got = c.fg.hex;
				return { ...base, pass: got === a.hex, expected: a.hex, got };
			}
			case "cell-bg": {
				const c = cellAt(grid, a.x, a.y);
				const got = c.bg.hex;
				return { ...base, pass: got === a.hex, expected: a.hex, got };
			}
			case "cell-glyph": {
				const c = cellAt(grid, a.x, a.y);
				return { ...base, pass: c.glyph === a.glyph, expected: a.glyph, got: c.glyph };
			}
			case "glyph-present": {
				const found = findGlyph(grid, a.glyph);
				return { ...base, pass: found !== null, expected: a.glyph, got: found };
			}
			case "text-present": {
				if (typeof a.text !== "string" || a.text.length === 0) return { ...base, pass: false, error: "text-present requires a non-empty text string" };
				const found = findText(grid, a.text);
				return { ...base, pass: found !== null, expected: a.text, got: found };
			}
			case "region-fg-subset":
			case "region-bg-subset": {
				const { fg, bg } = regionHexes(grid, a.x0, a.y0, a.x1, a.y1);
				const observed = a.kind === "region-fg-subset" ? fg : bg;
				const allow = new Set(a.palette);
				const extra = observed.filter((h) => !allow.has(h));
				return { ...base, pass: extra.length === 0, expected: `⊆ ${a.palette.length} palette`, got: observed, extra };
			}
			case "region-no-truecolor": {
				const ok = regionHasNoTruecolor(grid, a.x0, a.y0, a.x1, a.y1);
				return { ...base, pass: ok, expected: "no rgb cells", got: ok ? "none" : "rgb present" };
			}
			default:
				return { ...base, pass: false, error: `unknown assertion kind: ${a.kind}` };
		}
	} catch (err) {
		return { ...base, pass: false, error: err.message };
	}
}

// --- HTML review page -------------------------------------------------------

function esc(s) {
	return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

/** Map a cell's fg/bg to CSS colors; palette/default fall back to CSS names. */
function cssColor(field, fallback) {
	if (field.mode === "rgb" && field.hex) return field.hex;
	if (field.mode === "palette" && field.index != null) return `var(--x256-${field.index}, ${fallback})`;
	return fallback;
}

function gridToHtml(grid, title) {
	const rowsHtml = [];
	for (let y = 0; y < grid.rows; y += 1) {
		const spans = [];
		for (let x = 0; x < grid.cols; x += 1) {
			const c = grid.cells[y][x];
			const fg = cssColor(c.fg, "#e1e1e1");
			const bg = cssColor(c.bg, "#141414");
			const weight = c.attrs.bold ? "font-weight:700;" : "";
			const style = `color:${fg};background:${bg};${weight}`;
			spans.push(`<span style="${style}">${esc(c.glyph)}</span>`);
		}
		rowsHtml.push(`<div class="row">${spans.join("")}</div>`);
	}
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0b0b; color:#e1e1e1;
         font:14px/1.0 ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
  header { padding:10px 14px; border-bottom:1px solid #242424; }
  header h1 { margin:0; font-size:14px; font-weight:600; }
  header p { margin:4px 0 0; color:#6c6c6c; font-size:12px; }
  .grid { padding:14px; }
  .row { white-space:pre; }
  .row span { display:inline-block; width:1ch; }
</style></head>
<body>
  <header>
    <h1>${esc(title)}</h1>
    <p>${grid.cols}×${grid.rows} — rendered through @xterm/headless. Every cell below is a parsed grid cell; colors are the exact fg/bg reported by the terminal emulator.</p>
  </header>
  <div class="grid">${rowsHtml.join("\n")}</div>
</body></html>
`;
}

// --- IO helpers -------------------------------------------------------------

function readText(p) {
	if (!existsSync(p)) throw new HarnessError(`file not found: ${p}`, 2);
	return readFileSync(p, "utf8");
}

function writeFileEnsuring(p, content) {
	mkdirSync(dirname(resolve(p)), { recursive: true });
	writeFileSync(p, content);
}

function parseFlags(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i += 1) {
		const t = argv[i];
		if (t.startsWith("--")) {
			const key = t.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				flags[key] = true;
			} else {
				flags[key] = next;
				i += 1;
			}
		} else {
			positional.push(t);
		}
	}
	return { flags, positional };
}

// --- mode: render -----------------------------------------------------------

async function modeRender(argv) {
	const { flags, positional } = parseFlags(argv);
	const input = positional[0];
	if (!input) throw new HarnessError("render: missing <in.ans>", 2);
	const cols = Number(flags.cols);
	const rows = Number(flags.rows);
	if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
		throw new HarnessError("render: --cols N --rows M are required positive integers", 2);
	}
	const ansText = readText(input);
	const grid = await renderToGrid(ansText, cols, rows);
	const title = typeof flags.title === "string" ? flags.title : input;

	if (typeof flags["out-json"] === "string") {
		writeFileEnsuring(flags["out-json"], JSON.stringify(grid));
	}
	if (typeof flags["out-html"] === "string") {
		writeFileEnsuring(flags["out-html"], gridToHtml(grid, title));
	}
	if (!flags["out-json"] && !flags["out-html"]) {
		process.stdout.write(JSON.stringify(grid));
	}
	return 0;
}

// --- mode: assert -----------------------------------------------------------

/** Run a spec ({assertions:[...]}) against a grid file; print results. */
async function modeAssert(argv) {
	const { flags, positional } = parseFlags(argv);
	const gridPath = positional[0];
	if (!gridPath) throw new HarnessError("assert: missing <grid.json>", 2);
	const specPath = flags.spec;
	if (typeof specPath !== "string") throw new HarnessError("assert: --spec assertions.json required", 2);

	const grid = JSON.parse(readText(gridPath));
	const spec = JSON.parse(readText(specPath));
	const assertions = Array.isArray(spec) ? spec : spec.assertions ?? [];
	const results = assertions.map((a) => runAssertion(grid, a));
	const failed = results.filter((r) => !r.pass);
	process.stdout.write(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
	process.stdout.write("\n");
	return failed.length === 0 ? 0 : 1;
}

// --- modes: replay / raw-assert ---------------------------------------------

async function modeReplay(argv) {
	const { flags, positional } = parseFlags(argv);
	const input = positional[0];
	if (!input) throw new HarnessError("replay: missing <events.json>", 2);
	const plan = JSON.parse(readText(input));
	const replay = await replayToSnapshots(plan);
	const output = JSON.stringify(replay, null, 2);
	if (typeof flags["out-json"] === "string") writeFileEnsuring(flags["out-json"], output);
	else process.stdout.write(`${output}\n`);
	return 0;
}

async function modeRawAssert(argv) {
	const { flags, positional } = parseFlags(argv);
	const input = positional[0];
	if (!input) throw new HarnessError("raw-assert: missing <in.ans>", 2);
	const result = assertRawStream(readText(input), {
		expectClearReplay: flags["expect-clear-replay"] === true,
		replaySentinel: typeof flags["replay-sentinel"] === "string" ? flags["replay-sentinel"] : undefined,
	});
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	return result.pass ? 0 : 1;
}

// --- mode: verify-manifest --------------------------------------------------

/**
 * Verify a visual-claims manifest. A claim FAILS verification when it is
 * missing any required frame, any triplet leg (.ans/.html/.json) for a frame,
 * or produces no PASSING grid-based assertion result. Missing/failed assertions
 * are re-executed here against the on-disk grids so the manifest cannot lie.
 */
async function verifyManifest(manifestPath, opts = {}) {
	const manifest = JSON.parse(readText(manifestPath));
	const baseDir = opts.baseDir ?? dirname(resolve(manifestPath));
	const claims = manifest.claims ?? [];
	const report = { manifest: manifestPath, claims: [], ok: true };

	for (const claim of claims) {
		const c = { id: claim.id, ok: true, problems: [], frames: [], assertions: [] };

		const requiredFrames = claim.requiredFrames ?? [];
		if (requiredFrames.length === 0) {
			c.ok = false;
			c.problems.push("claim registers no required frames");
		}

		// Index provided frames by id.
		const provided = new Map((claim.frames ?? []).map((f) => [f.id, f]));

		for (const frameId of requiredFrames) {
			const f = provided.get(frameId);
			const fr = { id: frameId, ok: true, problems: [] };
			if (!f) {
				fr.ok = false;
				fr.problems.push("required frame is missing from claim.frames");
				c.ok = false;
				c.problems.push(`missing frame: ${frameId}`);
				c.frames.push(fr);
				continue;
			}
			// Triplet legs must all be present on disk.
			for (const leg of ["ans", "html", "json"]) {
				const rel = f[leg];
				if (!rel) {
					fr.ok = false;
					fr.problems.push(`triplet leg "${leg}" not declared`);
					continue;
				}
				const abs = isAbsolute(rel) ? rel : join(baseDir, rel);
				if (!existsSync(abs)) {
					fr.ok = false;
					fr.problems.push(`triplet leg "${leg}" file missing: ${rel}`);
				}
			}
			if (!fr.ok) {
				c.ok = false;
				c.problems.push(`incomplete triplet for frame: ${frameId}`);
			}
			c.frames.push(fr);
		}

		// Grid-based assertions: must exist AND pass when re-run on disk grids.
		const claimAssertions = claim.assertions ?? [];
		if (claimAssertions.length === 0) {
			c.ok = false;
			c.problems.push("claim has no grid-based assertions");
		}
		let anyPass = false;
		for (const a of claimAssertions) {
			const frame = provided.get(a.frame);
			if (!frame || !frame.json) {
				c.ok = false;
				c.assertions.push({ id: a.id, frame: a.frame, pass: false, error: "assertion targets a frame with no grid JSON" });
				continue;
			}
			const abs = isAbsolute(frame.json) ? frame.json : join(baseDir, frame.json);
			if (!existsSync(abs)) {
				c.ok = false;
				c.assertions.push({ id: a.id, frame: a.frame, pass: false, error: `grid JSON missing: ${frame.json}` });
				continue;
			}
			const grid = JSON.parse(readFileSync(abs, "utf8"));
			const res = runAssertion(grid, a);
			if (res.pass) anyPass = true;
			else c.ok = false;
			c.assertions.push({ ...res, frame: a.frame });
		}
		if (claimAssertions.length > 0 && !anyPass) {
			c.ok = false;
			c.problems.push("no grid-based assertion produced a PASS result");
		}

		if (!c.ok) report.ok = false;
		report.claims.push(c);
	}

	return report;
}

async function modeVerifyManifest(argv) {
	const { positional } = parseFlags(argv);
	const manifestPath = positional[0];
	if (!manifestPath) throw new HarnessError("verify-manifest: missing <manifest.json>", 2);
	const report = await verifyManifest(manifestPath);
	process.stdout.write(JSON.stringify(report, null, 2));
	process.stdout.write("\n");
	return report.ok ? 0 : 1;
}

// --- mode: self-test --------------------------------------------------------

/**
 * The harness self-test proves it works AND that it fails loudly:
 *  1. render a known fixture .ans, assert a known cell hex + glyph from the grid,
 *  2. corrupt the fixture (strip SGR) and prove the SAME assertion now FAILS,
 *  3. verify-manifest self-tests: a good manifest PASSES; a manifest with a
 *     missing frame FAILS; a manifest with no assertion FAILS.
 */
async function modeSelfTest() {
	const results = [];
	const fail = (name, detail) => {
		results.push({ name, ok: false, detail });
	};
	const pass = (name, detail) => {
		results.push({ name, ok: true, detail });
	};

	const fixtureDir = join(SCRIPT_DIR, "fixtures");
	const fixturePath = join(fixtureDir, "self-test-panel.ans");
	if (!existsSync(fixturePath)) {
		throw new HarnessError(`self-test fixture missing: ${fixturePath}`, 2);
	}
	const ansText = readText(fixturePath);
	const cols = 24;
	const rows = 3;
	const grid = await renderToGrid(ansText, cols, rows);

	// (1) Known-good assertions derived from the fixture's authored SGR bytes.
	// Cell (0,0) is a green accent glyph "◆" on the dark surface bg.
	const knownFg = runAssertion(grid, { kind: "cell-fg", x: 0, y: 0, hex: "#9ece6a" });
	const knownBg = runAssertion(grid, { kind: "cell-bg", x: 0, y: 0, hex: "#141414" });
	const knownGlyph = runAssertion(grid, { kind: "cell-glyph", x: 0, y: 0, glyph: "◆" });
	if (knownFg.pass && knownBg.pass && knownGlyph.pass) {
		pass("good-fixture-known-cell", { knownFg, knownBg, knownGlyph });
	} else {
		fail("good-fixture-known-cell", { knownFg, knownBg, knownGlyph });
	}

	// (2) Corrupted fixture: strip every SGR escape so the color is lost. The
	// SAME hex assertion must now FAIL — proving the harness detects corruption.
	// eslint-disable-next-line no-control-regex
	const corrupted = ansText.replace(/\x1b\[[0-9;]*m/g, "");
	const corruptedGrid = await renderToGrid(corrupted, cols, rows);
	const corruptedFg = runAssertion(corruptedGrid, { kind: "cell-fg", x: 0, y: 0, hex: "#9ece6a" });
	if (corruptedFg.pass === false) {
		pass("corrupted-fixture-fails-loudly", { corruptedFg });
	} else {
		fail("corrupted-fixture-fails-loudly", { corruptedFg, note: "corrupted fixture unexpectedly still matched" });
	}

	// Full text assertions prove a completed sentinel, not an incidental glyph.
	const knownText = runAssertion(grid, { kind: "text-present", text: "◆ Run" });
	const missingText = runAssertion(grid, { kind: "text-present", text: "◆ Missing" });
	if (knownText.pass && missingText.pass === false) {
		pass("text-present-requires-the-complete-rendered-sentinel", { knownText, missingText });
	} else {
		fail("text-present-requires-the-complete-rendered-sentinel", { knownText, missingText });
	}

	// (3) Replay must preserve a transcript across ordered write/resize events
	// and expose an independent parsed cell grid at each requested snapshot.
	const replay = await replayToSnapshots({
		cols: 20,
		rows: 4,
		scrollback: 20,
		events: [
			{ type: "write", data: `${"OLD-SCROLLBACK\n".repeat(8)}VISIBLE-TRANSCRIPT`, snapshot: "wide" },
			{ type: "resize", cols: 12, rows: 3, snapshot: "narrow" },
		],
	});
	const wide = replay.snapshots[0];
	const narrow = replay.snapshots[1];
	if (
		replay.scrollback > 0 &&
		wide?.grid.cols === 20 &&
		narrow?.grid.cols === 12 &&
		narrow?.grid.rows === 3 &&
		findGlyph(wide.grid, "T") !== null &&
		findGlyph(narrow.grid, "T") !== null
	) {
		pass("replay-ordered-write-resize-exposes-snapshot-grids", { snapshots: replay.snapshots.map((snapshot) => ({ label: snapshot.label, cols: snapshot.grid.cols, rows: snapshot.grid.rows })) });
	} else {
		fail("replay-ordered-write-resize-exposes-snapshot-grids", { replay });
	}

	// (4) Raw-stream checks must reject unbalanced DECSET 2026, use the
	// renderer's 2J,H,3J sequence, and prohibit cross-frame token stitching.
	const replayRaw = `${SYNC_BEGIN}\x1b[2J\x1b[H\x1b[3JREPLAY-TRANSCRIPT${SYNC_END}`;
	const rawGood = assertRawStream(replayRaw, { expectClearReplay: true, replaySentinel: "REPLAY-TRANSCRIPT" });
	const rawBroken = assertRawStream(replayRaw.replace(SYNC_END, ""), { expectClearReplay: true, replaySentinel: "REPLAY-TRANSCRIPT" });
	const crossFrameRaw = `${SYNC_BEGIN}\x1b[2J\x1b[H\x1b[3JFIRST_FRAME_WITHOUT_SENTINEL${SYNC_END}${SYNC_BEGIN}\x1b[HREPLAY-TRANSCRIPT${SYNC_END}`;
	const rawCrossFrame = assertRawStream(crossFrameRaw, { expectClearReplay: true, replaySentinel: "REPLAY-TRANSCRIPT" });
	if (rawGood.pass && rawBroken.pass === false && rawBroken.decset.balanced === false && rawCrossFrame.pass === false) {
		pass("raw-stream-decset-and-frame-gated-clear-replay-assertions", { rawGood, rawBroken, rawCrossFrame });
	} else {
		fail("raw-stream-decset-and-frame-gated-clear-replay-assertions", { rawGood, rawBroken, rawCrossFrame });
	}

	// (5) verify-manifest self-tests, using tiny in-memory manifests written to
	// a temp dir alongside the fixture grids.
	const tmpDir = join(fixtureDir, ".self-test-tmp");
	mkdirSync(tmpDir, { recursive: true });
	const goodAns = join(tmpDir, "f.ans");
	const goodJson = join(tmpDir, "f.json");
	const goodHtml = join(tmpDir, "f.html");
	writeFileSync(goodAns, ansText);
	writeFileSync(goodJson, JSON.stringify(grid));
	writeFileSync(goodHtml, gridToHtml(grid, "self-test"));

	const goodManifest = {
		claims: [
			{
				id: "self-test-claim",
				requiredFrames: ["f"],
				frames: [{ id: "f", ans: goodAns, html: goodHtml, json: goodJson }],
				assertions: [{ id: "a1", frame: "f", kind: "cell-glyph", x: 0, y: 0, glyph: "◆" }],
			},
		],
	};
	const goodManifestPath = join(tmpDir, "good-manifest.json");
	writeFileSync(goodManifestPath, JSON.stringify(goodManifest));
	const goodReport = await verifyManifest(goodManifestPath, { baseDir: tmpDir });
	if (goodReport.ok) pass("verify-manifest-good-passes", { ok: goodReport.ok });
	else fail("verify-manifest-good-passes", { report: goodReport });

	// Missing-frame manifest: requires a frame id that is not provided.
	const missingFrameManifest = {
		claims: [
			{
				id: "missing-frame-claim",
				requiredFrames: ["f", "not-provided"],
				frames: [{ id: "f", ans: goodAns, html: goodHtml, json: goodJson }],
				assertions: [{ id: "a1", frame: "f", kind: "cell-glyph", x: 0, y: 0, glyph: "◆" }],
			},
		],
	};
	const missingFramePath = join(tmpDir, "missing-frame-manifest.json");
	writeFileSync(missingFramePath, JSON.stringify(missingFrameManifest));
	const missingFrameReport = await verifyManifest(missingFramePath, { baseDir: tmpDir });
	if (missingFrameReport.ok === false) pass("verify-manifest-missing-frame-fails", { ok: missingFrameReport.ok });
	else fail("verify-manifest-missing-frame-fails", { report: missingFrameReport });

	// No-assertion manifest: registers a frame but no grid assertion.
	const noAssertionManifest = {
		claims: [
			{
				id: "no-assertion-claim",
				requiredFrames: ["f"],
				frames: [{ id: "f", ans: goodAns, html: goodHtml, json: goodJson }],
				assertions: [],
			},
		],
	};
	const noAssertionPath = join(tmpDir, "no-assertion-manifest.json");
	writeFileSync(noAssertionPath, JSON.stringify(noAssertionManifest));
	const noAssertionReport = await verifyManifest(noAssertionPath, { baseDir: tmpDir });
	if (noAssertionReport.ok === false) pass("verify-manifest-no-assertion-fails", { ok: noAssertionReport.ok });
	else fail("verify-manifest-no-assertion-fails", { report: noAssertionReport });

	// Missing-triplet-leg manifest: declares a frame whose .html file is absent.
	const missingLegManifest = {
		claims: [
			{
				id: "missing-leg-claim",
				requiredFrames: ["f"],
				frames: [{ id: "f", ans: goodAns, html: join(tmpDir, "does-not-exist.html"), json: goodJson }],
				assertions: [{ id: "a1", frame: "f", kind: "cell-glyph", x: 0, y: 0, glyph: "◆" }],
			},
		],
	};
	const missingLegPath = join(tmpDir, "missing-leg-manifest.json");
	writeFileSync(missingLegPath, JSON.stringify(missingLegManifest));
	const missingLegReport = await verifyManifest(missingLegPath, { baseDir: tmpDir });
	if (missingLegReport.ok === false) pass("verify-manifest-missing-triplet-leg-fails", { ok: missingLegReport.ok });
	else fail("verify-manifest-missing-triplet-leg-fails", { report: missingLegReport });

	// Clean the temp scratch so it never lands in the tree.
	rmSync(tmpDir, { recursive: true, force: true });

	const failed = results.filter((r) => !r.ok);
	process.stdout.write(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
	process.stdout.write("\n");
	return failed.length === 0 ? 0 : 1;
}

// --- entry ------------------------------------------------------------------

async function main() {
	const [mode, ...rest] = process.argv.slice(2);
	switch (mode) {
		case "render":
			return modeRender(rest);
		case "assert":
			return modeAssert(rest);
		case "replay":
			return modeReplay(rest);
		case "raw-assert":
			return modeRawAssert(rest);
		case "verify-manifest":
			return modeVerifyManifest(rest);
		case "self-test":
			return modeSelfTest();
		default:
			process.stderr.write(
				"usage: xterm-render.mjs <render|assert|replay|raw-assert|verify-manifest|self-test> ...\n" +
					"  render <in.ans> --cols N --rows M [--out-json f] [--out-html f] [--title t]\n" +
					"  assert <grid.json> --spec assertions.json\n" +
					"  replay <events.json> [--out-json f]\n" +
					"  raw-assert <in.ans> [--expect-clear-replay] [--replay-sentinel text]\n" +
					"  verify-manifest <manifest.json>\n" +
					"  self-test\n",
			);
			return 2;
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		if (err instanceof HarnessError) {
			process.stderr.write(`error: ${err.message}\n`);
			process.exit(err.code);
		}
		process.stderr.write(`error: ${err?.stack ?? err}\n`);
		process.exit(2);
	});

// Exported for potential in-process reuse (Go tests shell out to the CLI).
export { assertRawStream, gridToHtml, renderToGrid, replayToSnapshots, runAssertion, verifyManifest };
