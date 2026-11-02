#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	cliEntry,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	tsxEntry,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { chromeExecutable, spawnTerminal, waitForCapture, waitForExit } from "./eval-live-terminal.mjs";

const API = "openai-completions";
const COLS = 120;
const ROWS = 34;
const FINAL_MARKER = "EVAL-HEADLINE-DONE";
const SUMMARY = "Count the files in the sandbox, slowly";
const BADGE = String.raw`(?: \([^)]*\))?`;
const LIVE_HEADER = new RegExp(`eval js${BADGE} running[^·]{0,4}· [2-5]s`, "u");
const DONE_HEADER = new RegExp(`eval js${BADGE} done`, "u");
const COMMAND =
	"node .agents/skills/senpi-qa/scripts/scenarios/eval-live-headline-qa.mjs --self-test --evidence eval-live-headline";

const argv = process.argv.slice(2);
const evidenceIndex = argv.indexOf("--evidence");
const evidenceSlug = evidenceIndex >= 0 ? argv[evidenceIndex + 1] : undefined;
if (!argv.includes("--self-test")) throw new Error("pass --self-test");
if (!evidenceSlug) throw new Error("--evidence requires a slug");

function recordedChecks(title) {
	const rows = [];
	return {
		ok(name, pass, detail = "") {
			rows.push({ name, pass: Boolean(pass), detail });
			process.stdout.write(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}\n`);
		},
		finish() {
			const failed = rows.filter((row) => !row.pass).length;
			process.stdout.write(`\n${title}: ${rows.length - failed}/${rows.length} passed\n`);
			return { passed: failed === 0, rows };
		},
	};
}

function gridRows(grid) {
	return grid.cells.map((row) => row.map((cell) => cell.glyph).join("").trimEnd());
}

function sanitizedRequests(requests) {
	return requests.map((request) => ({
		method: request.method,
		url: request.url,
		model: request.model,
		toolNames: Array.isArray(request.tools) ? request.tools.map((tool) => tool.function?.name ?? tool.name) : [],
	}));
}

async function main() {
	installCleanupHooks();
	const checks = recordedChecks("eval-live-headline-qa.mjs --self-test");
	const guard = guardRealAuth();
	const root = repoRoot();
	const evidence = evidenceDir(evidenceSlug);
	const box = makeSandbox("eval-live-headline");
	writeFileSync(join(box.cwd, "note.txt"), "headline-qa\n");

	let server;
	let term;
	let raw = "";
	let finalRaw = "";
	let liveRaw = "";
	let runError;
	const cleanup = {
		ptyExited: false,
		serverStopped: false,
		sandboxRemoved: false,
		authUnchanged: false,
	};

	try {
		server = await startFakeModelServer({
			turns: [
				{
					toolCalls: [
						{
							name: "eval",
							args: {
								language: "js",
								summary: SUMMARY,
								code: [
									'const { readdir } = await import("node:fs/promises");',
									"await new Promise((resolve) => setTimeout(resolve, 6_000));",
									'(await readdir(".")).length;',
								].join("\n"),
							},
						},
					],
				},
				{ text: FINAL_MARKER },
			],
		});
		writeMockModelsJson(box.agentDir, server, API);
		const preset = API_PRESETS[API];
		term = await spawnTerminal(
			process.execPath,
			[
				tsxEntry(root),
				"--tsconfig",
				join(root, "tsconfig.json"),
				cliEntry(root),
				"--no-context-files",
				"--no-skills",
				"--no-extensions",
				"--approve",
				"--provider",
				preset.provider,
				"--model",
				preset.modelId,
				"Run the eval headline probe.",
			],
			{
				name: "xterm-color",
				cols: COLS,
				rows: ROWS,
				cwd: box.cwd,
				env: hermeticEnv(box.env),
				pipePath: join(box.dir, "eval-headline-pty.ans"),
			},
		);
		term.onData((data) => {
			raw += data;
		});
		await waitForCapture(term, () => raw, (text) => LIVE_HEADER.test(text), 120_000, "running eval row after 2s");
		liveRaw = raw;
		await waitForCapture(term, () => raw, (text) => text.includes(FINAL_MARKER), 120_000, "final model marker");
		finalRaw = raw;
	} catch (error) {
		runError = error;
	} finally {
		if (term) {
			const exited = waitForExit(term, 5_000);
			try {
				term.write("\x03\x03");
				term.kill();
			} catch {}
			cleanup.ptyExited = await exited;
		} else cleanup.ptyExited = true;
		if (server) {
			await server.stop().catch(() => {});
			cleanup.serverStopped = true;
		} else cleanup.serverStopped = true;
		box.cleanup();
		cleanup.sandboxRemoved = !existsSync(box.dir);
		try {
			cleanup.authUnchanged = guard.assertUnchanged();
		} catch {}
	}
	if (finalRaw.length === 0) finalRaw = raw;

	const chrome = chromeExecutable();
	const renderFrame = (name, bytes) => {
		const rawPath = join(evidence, `${name}.ans`);
		const gridPath = join(evidence, `${name}.grid.json`);
		const htmlPath = join(evidence, `${name}.html`);
		const screenshotPath = join(evidence, `${name}.png`);
		// The runtime badge names the interpreter's absolute path; the evidence is public, so the home directory is redacted.
		writeFileSync(rawPath, bytes.replaceAll(homedir(), "~"));
		const xterm = spawnSync(
			process.execPath,
			[join(root, "scripts", "qa", "xterm-render.mjs"), "render", rawPath, "--cols", String(COLS), "--rows", String(ROWS), "--out-json", gridPath, "--out-html", htmlPath, "--title", `Senpi eval ${name}`],
			{ cwd: root, encoding: "utf8" },
		);
		const grid = existsSync(gridPath) ? JSON.parse(readFileSync(gridPath, "utf8")) : undefined;
		const rows = grid ? gridRows(grid) : [];
		writeFileSync(join(evidence, `${name}.txt`), `${rows.join("\n")}\n`);
		const shot =
			chrome === undefined
				? undefined
				: spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,720", "--virtual-time-budget=2000", `--screenshot=${screenshotPath}`, pathToFileURL(resolve(htmlPath)).href], { encoding: "utf8" });
		return { ok: xterm.status === 0 && grid !== undefined, rows, shot: shot?.status === 0 && existsSync(screenshotPath), error: xterm.stderr || xterm.stdout };
	};
	const live = renderFrame("live", liveRaw || raw);
	const done = renderFrame("done", finalRaw);
	const liveHeader = live.rows.find((row) => LIVE_HEADER.test(row)) ?? "";
	const doneIndex = done.rows.findIndex((row) => DONE_HEADER.test(row));
	const agentRequests =
		server?.requests.filter(
			(request) =>
				Array.isArray(request.tools) &&
				request.tools.some((tool) => (tool.function?.name ?? tool.name) === "eval"),
		) ?? [];

	checks.ok("scenario completed without runtime error", runError === undefined, runError instanceof Error ? runError.message : "");
	checks.ok(
		"fake provider handled eval and final agent turns",
		agentRequests.length === 2,
		`agentRequests=${agentRequests.length} totalRequests=${server?.requests.length ?? 0}`,
	);
	checks.ok("xterm.js rendered both frames", live.ok && done.ok, live.error || done.error);
	checks.ok("live row leads with the summary", new RegExp(`[╭╶]─ \\S ${SUMMARY} · eval js`, "u").test(liveHeader), liveHeader);
	checks.ok("live row shows elapsed time", /· [2-5]s/u.test(liveHeader), liveHeader);
	checks.ok("live row hides the code", !live.rows.join("\n").includes("setTimeout(resolve"), live.rows.filter((row) => row.includes("setTimeout")).join(" | "));
	checks.ok("done row keeps its header, summary line and code", doneIndex >= 0 && (done.rows[doneIndex + 1] ?? "").includes(SUMMARY) && done.rows.join("\n").includes("setTimeout(resolve"), done.rows.slice(Math.max(0, doneIndex), doneIndex + 4).join(" | "));
	checks.ok("Chrome produced both screenshots", live.shot && done.shot);
	checks.ok("all spawned resources and auth guard cleaned", Object.values(cleanup).every(Boolean), JSON.stringify(cleanup));
	const result = checks.finish();

	writeFileSync(join(evidence, "command.txt"), `${COMMAND}\n`);
	writeFileSync(join(evidence, "requests.json"), `${JSON.stringify(sanitizedRequests(server?.requests ?? []), null, 2)}\n`);
	writeFileSync(join(evidence, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
	writeFileSync(join(evidence, "checks.json"), `${JSON.stringify(result.rows, null, 2)}\n`);
	if (runError) writeFileSync(join(evidence, "error.txt"), `${runError instanceof Error ? runError.stack : String(runError)}\n`);
	process.stderr.write(`evidence: ${evidence}\n`);
	process.exit(result.passed ? 0 : 1);
}

await main();
