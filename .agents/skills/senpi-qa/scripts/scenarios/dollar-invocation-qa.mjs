#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import xtermHeadless from "@xterm/headless";
import { evidenceDir } from "../lib/common.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const { Terminal } = xtermHeadless;
const args = process.argv.slice(2);
const channelIndex = args.indexOf("--channel");
const evidenceIndex = args.indexOf("--evidence");
const channel = channelIndex >= 0 ? args[channelIndex + 1] : undefined;
const evidenceName = evidenceIndex >= 0 ? args[evidenceIndex + 1] : undefined;

if (channel !== "rpc" && channel !== "tui") {
	throw new Error("--channel must be rpc or tui");
}
if (!evidenceName) {
	throw new Error("--evidence requires a value");
}

function runNode(script, scriptArgs) {
	const result = spawnSync(process.execPath, [script, ...scriptArgs], {
		cwd: join(scriptDir, "../../../../.."),
		env: process.env,
		encoding: "utf8",
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${script} exited with status ${result.status}`);
	}
}

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

async function renderXtermHtml(rawPath, htmlPath) {
	const terminal = new Terminal({
		allowProposedApi: true,
		cols: 120,
		rows: 34,
		scrollback: 2_000,
	});
	try {
		await new Promise((resolve) => terminal.write(readFileSync(rawPath, "utf8"), resolve));
		const lines = [];
		for (let index = 0; index < terminal.buffer.active.length; index++) {
			lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? "");
		}
		writeFileSync(
			htmlPath,
			`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Senpi dollar invocation TUI</title>
<style>
html, body { margin: 0; min-height: 100%; background: #0b0f14; color: #d8dee9; }
body { display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
pre {
  width: 120ch;
  min-height: 34lh;
  margin: 0;
  padding: 18px 22px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid #29323d;
  border-radius: 8px;
  background: #10151c;
  font: 14px/1.25 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: pre;
}
</style>
</head>
<body><pre>${escapeHtml(lines.join("\n"))}</pre></body>
</html>
`,
		);
	} finally {
		terminal.dispose();
	}
}

if (channel === "rpc") {
	runNode(join(scriptDir, "rpc-input-hardening-qa.mjs"), ["--evidence", evidenceName]);
	runNode(join(scriptDir, "dollar-skill-invocation-qa.mjs"), ["--evidence", evidenceName]);
	process.exit(0);
}

runNode(join(scriptDir, "..", "tui-scenario.mjs"), [
	"--scenario",
	"dollar-invocation",
	"--driver",
	"tmux",
	"--evidence",
	evidenceName,
]);

const evidence = evidenceDir(evidenceName);
const rawPath = join(evidence, "tui-scenario-dollar-invocation-tmux.raw.txt");
const htmlPath = join(evidence, "tui-scenario-dollar-invocation-tmux-xterm.html");
const screenshotPath = join(evidence, "tui-dollar-invocation-xterm.png");
if (!existsSync(rawPath)) {
	throw new Error(`missing TUI capture: ${rawPath}`);
}
await renderXtermHtml(rawPath, htmlPath);

const chromePath =
	process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chromePath)) {
	throw new Error(`Chrome executable not found: ${chromePath}`);
}

const screenshot = spawnSync(
	chromePath,
	[
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--window-size=1280,720",
		"--virtual-time-budget=2000",
		`--screenshot=${screenshotPath}`,
		pathToFileURL(htmlPath).href,
	],
	{ encoding: "utf8" },
);
if (screenshot.error) throw screenshot.error;
if (screenshot.status !== 0 || !existsSync(screenshotPath)) {
	throw new Error(`xterm.js screenshot failed: ${screenshot.stderr || screenshot.stdout}`);
}

console.log(`Dollar invocation TUI QA screenshot: ${screenshotPath}`);
