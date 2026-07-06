#!/usr/bin/env node
// xterm-render.mjs — the neo TUI evidence harness CORE (plan task 2).
//
// It is the mandatory renderer behind the plan's EVIDENCE FORMAT RULE: every
// TUI-visual claim in every neo todo is proven against a TRIPLET —
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
async function renderToGrid(ansText, cols, rows) {
	const Terminal = await loadTerminal();
	const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	await new Promise((res) => term.write(ansText, res));

	const buf = term.buffer.active;
	const cells = [];
	// Reusable cell accessor avoids per-cell allocation in xterm.
	for (let y = 0; y < rows; y += 1) {
		const line = buf.getLine(y);
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
	term.dispose();
	return { cols, rows, cells };
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

/**
 * Execute one assertion object against a grid, returning a result record.
 * Supported assertion kinds:
 *   cell-fg    {x,y,hex}          fg truecolor hex equals
 *   cell-bg    {x,y,hex}          bg truecolor hex equals
 *   cell-glyph {x,y,glyph}        glyph equals
 *   glyph-present {glyph}         glyph appears somewhere
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

	// (3) verify-manifest self-tests, using tiny in-memory manifests written to
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
		case "verify-manifest":
			return modeVerifyManifest(rest);
		case "self-test":
			return modeSelfTest();
		default:
			process.stderr.write(
				"usage: xterm-render.mjs <render|assert|verify-manifest|self-test> ...\n" +
					"  render <in.ans> --cols N --rows M [--out-json f] [--out-html f] [--title t]\n" +
					"  assert <grid.json> --spec assertions.json\n" +
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
export { renderToGrid, runAssertion, verifyManifest, gridToHtml };
