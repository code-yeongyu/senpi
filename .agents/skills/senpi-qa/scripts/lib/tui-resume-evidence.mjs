import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripAnsi } from "./common.mjs";
import { COLS, COMMAND, FINAL_MARKER, FIRST_MARKER, ROWS, SESSION_ID, TUI_ARGS } from "./tui-resume-args.mjs";

function chromeExecutable() {
	const candidates = [
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter((candidate) => typeof candidate === "string");
	return candidates.find((candidate) => existsSync(candidate));
}

function renderPngFromHtml(htmlPath, pngPath) {
	const chrome = chromeExecutable();
	if (!chrome) throw new Error("Chrome not found for headless screenshot");
	const result = spawnSync(
		chrome,
		[
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--no-first-run",
			"--no-default-browser-check",
			"--window-size=1400,900",
			`--screenshot=${pngPath}`,
			pathToFileURL(htmlPath).href,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0 || !existsSync(pngPath) || statSync(pngPath).size === 0) {
		throw new Error(`Chrome screenshot failed: ${result.stderr || result.stdout || `status=${result.status}`}`);
	}
}

function runXterm(root, args) {
	const result = spawnSync(process.execPath, [join(root, "scripts", "qa", "xterm-render.mjs"), ...args], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`xterm-render ${args[0]} failed: ${result.stderr || result.stdout || `status=${result.status}`}`);
	}
	return result;
}

export function isPng(path) {
	if (!existsSync(path) || statSync(path).size === 0) return false;
	const bytes = readFileSync(path);
	return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export function writeResumeArtifacts(evidence, { raw, actions, timing, runError, options, sessionPath }) {
	const plain = stripAnsi(raw);
	const ansPath = join(evidence, "terminal.ans");
	const txtPath = join(evidence, "terminal.txt");
	const gridPath = join(evidence, "terminal.grid.json");
	const htmlPath = join(evidence, "terminal.html");
	const pngPath = join(evidence, "terminal.png");
	const specPath = join(evidence, "assertions.json");
	writeFileSync(ansPath, raw);
	writeFileSync(txtPath, plain);
	writeFileSync(join(evidence, "action-log.json"), `${JSON.stringify(actions, null, 2)}\n`);
	writeFileSync(join(evidence, "timing.json"), `${JSON.stringify(timing ?? { error: String(runError) }, null, 2)}\n`);
	writeFileSync(
		join(evidence, "metadata.json"),
		`${JSON.stringify(
			{
				command: COMMAND,
				messages: options.messages,
				select: options.select,
				evidence: options.evidence,
				cols: COLS,
				rows: ROWS,
				sessionId: SESSION_ID,
				sessionPath,
				firstMarker: FIRST_MARKER,
				finalMarker: FINAL_MARKER,
				tuiArgs: TUI_ARGS,
			},
			null,
			2,
		)}\n`,
	);
	return { ansPath, txtPath, gridPath, htmlPath, pngPath, specPath };
}

export function captureGridEvidence(root, paths) {
	runXterm(root, [
		"render",
		paths.ansPath,
		"--cols",
		String(COLS),
		"--rows",
		String(ROWS),
		"--out-json",
		paths.gridPath,
		"--out-html",
		paths.htmlPath,
		"--title",
		"Senpi /resume TUI",
	]);
	writeFileSync(
		paths.specPath,
		`${JSON.stringify({ assertions: [{ id: "final-marker", kind: "text-present", text: FINAL_MARKER }] }, null, 2)}\n`,
	);
	const asserted = runXterm(root, ["assert", paths.gridPath, "--spec", paths.specPath]);
	const gridAssert = JSON.parse(asserted.stdout);
	renderPngFromHtml(paths.htmlPath, paths.pngPath);
	return gridAssert;
}
