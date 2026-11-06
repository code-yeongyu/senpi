/**
 * Surface QA (senpi#6092): the footer follows a model switch at once, in the REAL TUI.
 * Boots the interactive TUI in tmux against the local fake model server with two
 * mock models (a 1M window and a 128k window), then drives both switch paths:
 *   held    - a seeded 321k-token transcript, `/model` onto the 128k model: the
 *             footer must name the target with the pending marker before any
 *             compaction, and name the target alone after the next send compacts.
 *   direct  - a fresh session, the same `/model`: the footer names the target at once.
 * Every frame is captured with escapes, rendered through scripts/qa/xterm-render.mjs
 * (grid JSON + HTML), asserted on the parsed cell grid, and screenshotted with headless Chrome.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	cliEntry,
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	scrubSandboxEnv,
	stripAnsi,
	tsxEntry,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

const COLS = 140;
const ROWS = 30;
const BIG_MODEL = "mock-model";
const SMALL_MODEL = "mock-small";
const HELD_LABEL = `${BIG_MODEL} → ${SMALL_MODEL} (after compact)`;
const CHROME_CANDIDATES = [
	process.env.SENPI_QA_CHROME,
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

const argv = process.argv.slice(2);
if (!argv.includes("--self-test")) throw new Error("pass --self-test (--evidence <slug> optional)");
const evidenceIndex = argv.indexOf("--evidence");
const evidenceSlug = evidenceIndex >= 0 ? argv[evidenceIndex + 1] : "footer-held-switch";
if (!evidenceSlug) throw new Error("--evidence requires a slug");

const checks = createChecks("footer-held-switch-qa.mjs --self-test");
const guard = guardRealAuth();
installCleanupHooks();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const root = repoRoot();
const ev = evidenceDir(evidenceSlug);
const box = makeSandbox("footer-held-switch-tui");
const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

const server = await startFakeModelServer({
	turns: [{ text: "compact summary" }, { text: "SWITCH-QA-OK" }],
});
writeMockModelsJson(
	box.agentDir,
	server,
	"openai-completions",
	{ contextWindow: 1_000_000 },
	{ models: [{ id: SMALL_MODEL, contextWindow: 128_000 }] },
);

const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });
const session = `senpi-qa-held-switch-${process.pid}`;
const captureRaw = () => {
	try {
		return tmux("capture-pane", "-e", "-t", session, "-p");
	} catch {
		return "";
	}
};
const killSession = () => {
	try {
		execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
	} catch {}
};

function gridRows(grid) {
	return grid.cells.map((row) => row.map((cell) => cell.glyph).join("").replace(/\s+$/, ""));
}

function footerRowIndex(grid) {
	const rows = gridRows(grid);
	for (let y = rows.length - 1; y >= 0; y -= 1) if (rows[y].includes("(auto)")) return y;
	return -1;
}

function footerRow(grid) {
	const y = footerRowIndex(grid);
	return y < 0 ? "" : gridRows(grid)[y];
}

// tmux capture-pane -p joins rows with a bare LF; xterm needs CR LF or every row starts where the previous one ended.
const paneToStream = (raw) => raw.replace(/\r?\n/g, "\r\n");

function renderFrame(name, raw) {
	const ansPath = join(ev, `${name}.ans`);
	const gridPath = join(ev, `${name}.grid.json`);
	const htmlPath = join(ev, `${name}.html`);
	writeFileSync(ansPath, paneToStream(raw));
	writeFileSync(join(ev, `${name}.txt`), stripAnsi(raw));
	execFileSync(
		process.execPath,
		[
			join(root, "scripts", "qa", "xterm-render.mjs"),
			"render",
			ansPath,
			"--cols",
			String(COLS),
			"--rows",
			String(ROWS),
			"--out-json",
			gridPath,
			"--out-html",
			htmlPath,
			"--title",
			`senpi footer held switch: ${name}`,
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (chrome) {
		const profile = join(ev, `.chrome-${name}`);
		mkdirSync(profile, { recursive: true });
		execFileSync(
			chrome,
			[
				"--headless=new",
				"--disable-gpu",
				"--hide-scrollbars",
				"--no-first-run",
				"--no-default-browser-check",
				`--user-data-dir=${profile}`,
				"--window-size=1500,760",
				`--screenshot=${join(ev, `${name}.png`)}`,
				pathToFileURL(htmlPath).href,
			],
			{ stdio: "ignore", timeout: 60_000 },
		);
	}
	const grid = JSON.parse(readFileSync(gridPath, "utf8"));
	return { grid, footer: footerRow(grid) };
}

// The label must sit on the FOOTER row, so the spec pins every glyph of the expected text to its cell
// there (a text-present hit anywhere else, such as the composer echoing the /model command, proves nothing).
function assertFooter(name, grid, text) {
	const specPath = join(ev, `${name}.assert.json`);
	const y = footerRowIndex(grid);
	const row = y < 0 ? "" : gridRows(grid)[y];
	const x = row.indexOf(text);
	const assertions =
		y < 0 || x < 0
			? [{ id: `${name}:footer-row-has:${text}`, kind: "text-present", text: `FOOTER ROW MISSING ${text}` }]
			: [...text].map((glyph, i) => ({ id: `${name}:footer[${x + i}]`, kind: "cell-glyph", x: x + i, y, glyph }));
	writeFileSync(specPath, JSON.stringify({ footerRow: y, footerText: row, assertions }, null, 2));
	let out = "";
	let ok = true;
	try {
		out = execFileSync(process.execPath, [join(root, "scripts", "qa", "xterm-render.mjs"), "assert", join(ev, `${name}.grid.json`), "--spec", specPath], {
			cwd: root,
			encoding: "utf8",
		});
	} catch (error) {
		ok = false;
		out = String(error.stdout ?? error.message);
	}
	writeFileSync(join(ev, `${name}.assert.out`), out);
	return ok;
}

// Four turns: three large earlier turns the compaction can summarize, then a short one whose reported
// usage puts the live context at 321k tokens, far above the small model's 128k window.
function seedHeldSession(path) {
	const now = Date.now();
	const turns = 4;
	const lines = [{ type: "session", version: 3, id: randomUUID(), timestamp: new Date(now - turns * 2_000 - 1_000).toISOString(), cwd: box.cwd }];
	let parentId = null;
	for (let turn = 0; turn < turns; turn += 1) {
		const last = turn === turns - 1;
		const userAt = now - (turns - turn) * 2_000;
		const assistantAt = userAt + 1_000;
		const userId = randomUUID();
		const assistantId = randomUUID();
		const reportedInput = last ? 320_000 : 60_000 * (turn + 1);
		lines.push({
			type: "message",
			id: userId,
			parentId,
			timestamp: new Date(userAt).toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: last ? "continue the work" : `turn ${turn + 1} large live context `.repeat(10_000) }],
				timestamp: userAt,
			},
		});
		lines.push({
			type: "message",
			id: assistantId,
			parentId: userId,
			timestamp: new Date(assistantAt).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: last ? "still working" : `earlier response ${turn + 1}` }],
				api: "openai-completions",
				provider: "mock",
				model: BIG_MODEL,
				stopReason: "stop",
				usage: {
					input: reportedInput,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: reportedInput + 1_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: assistantAt,
			},
		});
		parentId = assistantId;
	}
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

// The tmux pane inherits this process's environment, so the brand/session steering names the
// sandbox scrubs for a spawned child (an omo session's OMO_CODING_AGENT_DIR, SENPI_BRAND, PI_SESSION_*)
// and the provider keys are unset in the pane by NAME before the CLI starts; values never leave the process.
const inherited = { ...process.env };
const scrubbedNames = scrubSandboxEnv(inherited);
const providerNames = Object.keys(inherited).filter((name) => !(name in hermeticEnv(inherited)));
const unsetNames = [...new Set([...scrubbedNames, ...providerNames])].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
const env = {
	SENPI_CODING_AGENT_DIR: box.agentDir,
	SENPI_CODING_AGENT_SESSION_DIR: box.sessionDir,
	HOME: box.dir,
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
	SENPI_OMO_LOCAL_UPDATE: "0",
};
const envExports = [
	...(unsetNames.length > 0 ? [`unset ${unsetNames.join(" ")}`] : []),
	...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`),
].join(" && ");

async function bootTui(extraArgs) {
	killSession();
	tmux("new-session", "-d", "-s", session, "-x", String(COLS), "-y", String(ROWS));
	tmux("set-option", "-t", session, "remain-on-exit", "on");
	const args = [
		"--no-context-files",
		"--no-skills",
		"--no-extensions",
		"--approve",
		"--provider",
		"mock",
		"--model",
		BIG_MODEL,
		...extraArgs,
	]
		.map(shq)
		.join(" ");
	tmux(
		"send-keys",
		"-t",
		session,
		`cd ${shq(box.cwd)} && ${envExports} && exec ${shq(process.execPath)} ${shq(tsxEntry(root))} --tsconfig ${shq(join(root, "tsconfig.json"))} ${shq(cliEntry(root))} ${args}`,
		"Enter",
	);
	const raw = await waitFor((plain) => /\(auto\)/.test(plain) || /Pane is dead/.test(plain), 90);
	if (!/\(auto\)/.test(stripAnsi(raw))) {
		writeFileSync(join(ev, "boot-failure.txt"), stripAnsi(raw));
		throw new Error(`TUI did not boot; pane captured to ${join(ev, "boot-failure.txt")}`);
	}
	return raw;
}

async function waitFor(predicate, seconds) {
	let raw = "";
	for (let i = 0; i < seconds; i++) {
		await sleep(1000);
		raw = captureRaw();
		if (predicate(stripAnsi(raw))) return raw;
	}
	return raw;
}

async function settle(seconds = 3) {
	await sleep(seconds * 1000);
	return captureRaw();
}

const composerLine = (raw) => stripAnsi(raw).split("\n").find((line) => line.startsWith("\u276f ")) ?? "";
// Notices wrap at the pane width, so transcript text is searched with runs of whitespace (and line breaks) collapsed.
const transcriptText = (raw) => stripAnsi(raw).replace(/\s+/g, " ");

// The composer autocompletes `/model <id>` to `/model <provider>/<id>`; the first Enter accepts that
// suggestion and only the next one submits, so Enter is repeated while the command is still in the composer.
async function submitCommand(text) {
	tmux("send-keys", "-t", session, "-l", text);
	await sleep(700);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		tmux("send-keys", "-t", session, "Enter");
		await sleep(1200);
		if (!composerLine(captureRaw()).includes(text.split(" ")[0])) return;
	}
}

try {
	// Held path: the seeded transcript is far above the small model's window.
	const seeded = join(box.cwd, "held-switch-seed.jsonl");
	seedHeldSession(seeded);
	const heldBoot = renderFrame("held-1-before", await bootTui(["--session", seeded]));
	checks.ok("held: TUI booted on the big model", heldBoot.footer.includes(BIG_MODEL), `footer=${heldBoot.footer}`);

	await submitCommand(`/model mock/${SMALL_MODEL}`);
	const heldRaw = await waitFor((plain) => plain.includes("after compact") || plain.replace(/\s+/g, " ").includes("switch applies after that"), 60);
	const held = renderFrame("held-2-pending", heldRaw);
	checks.ok(
		"held: footer names the target with the pending marker before any compaction",
		assertFooter("held-2-pending", held.grid, HELD_LABEL),
		`footer=${held.footer}`,
	);
	checks.ok(
		"held: the hold notice is in the transcript",
		transcriptText(heldRaw).includes("the switch applies after that"),
		"notice present",
	);
	checks.ok(
		"held: the status line says the pick applies after the next compaction",
		transcriptText(heldRaw).includes(`Model: ${SMALL_MODEL} · after the next compaction`),
		"status present",
	);

	await submitCommand("continue");
	const appliedRaw = await waitFor((plain) => plain.includes("SWITCH-QA-OK"), 90);
	const applied = renderFrame("held-3-applied", appliedRaw);
	checks.ok("held: the next send compacted and answered on the target", stripAnsi(appliedRaw).includes("SWITCH-QA-OK"), "turn output present");
	checks.ok(
		"held: footer names the target alone once the switch applied",
		assertFooter("held-3-applied", applied.grid, SMALL_MODEL) && !applied.footer.includes("after compact") && !applied.footer.includes("→"),
		`footer=${applied.footer}`,
	);
	tmux("send-keys", "-t", session, "C-c");
	tmux("send-keys", "-t", session, "C-c");
	await sleep(1000);
	killSession();

	// Direct path: a fresh session fits the small model, so the switch applies at once.
	const directBoot = renderFrame("direct-1-before", await bootTui([]));
	checks.ok("direct: TUI booted on the big model", directBoot.footer.includes(BIG_MODEL), `footer=${directBoot.footer}`);
	await submitCommand(`/model mock/${SMALL_MODEL}`);
	const directRaw = await waitFor((plain) => plain.includes(`Model: ${SMALL_MODEL}`), 60);
	const direct = renderFrame("direct-2-applied", directRaw);
	checks.ok(
		"direct: footer names the target at once with no pending marker",
		assertFooter("direct-2-applied", direct.grid, SMALL_MODEL) && !direct.footer.includes("after compact") && !direct.footer.includes("→"),
		`footer=${direct.footer}`,
	);
	checks.ok(
		"direct: the status line names the applied model without a hold",
		transcriptText(directRaw).includes(`Model: ${SMALL_MODEL}`) && !transcriptText(directRaw).includes("after the next compaction"),
		"status present",
	);
	checks.ok("screenshots rendered through headless Chrome", chrome !== undefined && existsSync(join(ev, "held-2-pending.png")), chrome ?? "no chrome binary found");
} finally {
	killSession();
	await server.stop();
	box.cleanup();
	checks.ok("real auth unchanged", guard.assertUnchanged(), "auth.json sha256 stable");
	checks.finish();
}
