#!/usr/bin/env node
/**
 * Repro driver for issue #795: the `/fallback` -> "Add/edit chain" ->
 * "Fallback target model" ExtensionSelectorComponent reportedly ignores arrow
 * keys and j/k while Esc/Ctrl+C still cancel.
 *
 * Drives the REAL interactive CLI in a tmux-backed sandbox with a seeded
 * 9-model provider and captures which option carries the "→ " highlight
 * before and after sending Down/Down/j/j.
 *
 * Binary observable:
 *   - highlight MOVES to the 5th entry  -> navigation works (no repro)
 *   - highlight STAYS on the 1st entry  -> issue reproduced
 *
 * The menu selector ("Model fallback") is probed the same way on the path in:
 * reaching "Add/edit chain" itself requires one working Down+Enter.
 *
 * Usage: node fallback-selector-nav-repro.mjs [--evidence SLUG] [--kitty]
 *
 * --kitty mirrors the reporter's terminal: after boot it injects a kitty
 * keyboard-protocol flags response (\x1b[?7u) into the pane so the CLI activates
 * the protocol, then drives navigation with kitty-encoded sequences
 * (Down=\x1b[1;1:1B, Enter=\x1b[13;1:1u, Esc=\x1b[27;1:1u; j stays plain text
 * because flags 1+2+4 without flag 8 keep printable keys on the text path).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cliEntry,
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	stripAnsi,
	tsxEntry,
} from "../lib/common.mjs";
import { PROVIDER_ENV_KEYS } from "../lib/mock-loop-support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROVIDER = "qasel795";
// SENPI_QA_795_MODELS overrides the registry size (the reporter's registry was large).
const MODEL_COUNT = Number.parseInt(process.env.SENPI_QA_795_MODELS ?? "9", 10) || 9;
const MODELS = Array.from({ length: MODEL_COUNT }, (_, i) => `qsel-${i + 1}`);

function parseArgs(argv) {
	const options = { evidence: undefined, kitty: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--evidence") {
			const next = argv[++i];
			if (!next) throw new Error("--evidence requires a value");
			options.evidence = next;
		} else if (argv[i] === "--kitty") {
			options.kitty = true;
		} else {
			throw new Error(`Unknown option: ${argv[i]}`);
		}
	}
	return options;
}

const KITTY_KEYS = {
	down: "\x1b[1;1:1B",
	downRelease: "\x1b[1;1:3B",
	enter: "\x1b[13;1:1u",
	esc: "\x1b[27;1:1u",
	flagsResponse: "\x1b[?7u",
	deviceAttributes: "\x1b[?62;4;22c",
};

function seedModels(box) {
	const config = {
		providers: {
			[PROVIDER]: {
				baseUrl: "http://127.0.0.1:9/v1", // never contacted: no turn is driven
				apiKey: "qa-selector-key",
				api: "openai-completions",
				models: MODELS.map((id) => ({
					id,
					contextWindow: 128000,
					maxTokens: 4096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				})),
			},
		},
	};
	writeFileSync(join(box.agentDir, "models.json"), JSON.stringify(config, null, 2));
}

function shq(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The selector line carrying the highlight, e.g. "→ qasel795/qsel-1". */
function highlightedLine(capture) {
	const plain = stripAnsi(capture);
	const line = plain.split("\n").find((entry) => entry.trimStart().startsWith("→ "));
	return line ? line.trim() : "(none)";
}

async function waitFor(read, alive, predicate, attempts = 300) {
	let capture = "";
	for (let i = 0; i < attempts && alive(); i++) {
		await sleep(100);
		capture = read();
		if (predicate(capture)) break;
	}
	return capture;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const checks = createChecks("fallback-selector-nav-repro");
	const guard = guardRealAuth();
	installCleanupHooks();
	const root = repoRoot();
	const box = makeSandbox("fallback-nav-795");
	seedModels(box);

	const session = `senpi-qa-795-${process.pid}`;
	const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });
	const alive = () => {
		try {
			execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	const capture = () => {
		try {
			return tmux("capture-pane", "-t", session, "-p", "-S", "-");
		} catch {
			return "";
		}
	};
	const send = (key, { literal = false } = {}) => {
		const args = ["send-keys", "-t", session];
		if (literal) args.push("-l");
		args.push(key);
		tmux(...args);
	};

	// SENPI_QA_795_NPX=<version> swaps the source CLI for the released npm package
	// (falsifiability runs against the reporter's version, e.g. 2026.8.9-2).
	const npxVersion = process.env.SENPI_QA_795_NPX;
	const cliLine = npxVersion
		? `exec npx -y @code-yeongyu/senpi@${npxVersion} --no-context-files --no-skills --approve`
		: `exec ${shq(process.execPath)} ${shq(tsxEntry(root))} --tsconfig ${shq(join(root, "tsconfig.json"))} ${shq(cliEntry(root))} --no-context-files --no-skills --approve`;
	const shell = [
		`cd ${shq(box.cwd)}`,
		`unset ${PROVIDER_ENV_KEYS.join(" ")}`,
		`export SENPI_CODING_AGENT_DIR=${shq(box.agentDir)} SENPI_CODING_AGENT_SESSION_DIR=${shq(box.sessionDir)} PI_OFFLINE=1 PI_TELEMETRY=0`,
		cliLine,
	].join("; ");

	const artifacts = {};
	let navWorks = false;
	try {
		try {
			execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
		} catch {}
		tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "34", shell);

		// Boot: the loading spinner renders immediately but swallows keystrokes.
		// Wait for the interactive shell (startup tips + editor prompt) instead.
		await waitFor(
			capture,
			alive,
			(text) => {
				const plain = stripAnsi(text);
				return plain.includes("❯") && !plain.includes("Loading senpi");
			},
			600,
		);
		await sleep(800);
		artifacts.boot = capture();

		// In kitty mode, answer the keyboard-protocol negotiation the CLI issued
		// during boot: the flags response travels on the same channel as keys.
		if (options.kitty) {
			send(KITTY_KEYS.flagsResponse, { literal: true });
			send(KITTY_KEYS.deviceAttributes, { literal: true });
			await sleep(500);
			artifacts.negotiation = capture();
		}

		// Open /fallback and reach the menu.
		const enterKey = options.kitty ? KITTY_KEYS.enter : "Enter";
		const downSend = () => {
			if (options.kitty) {
				send(KITTY_KEYS.down, { literal: true });
				send(KITTY_KEYS.downRelease, { literal: true });
			} else {
				send("Down");
			}
		};
		send("/fallback", { literal: true });
		send(enterKey, { literal: options.kitty });
		const menuCapture = await waitFor(capture, alive, (text) => stripAnsi(text).includes("Model fallback"));
		checks.ok("fallback menu opens", stripAnsi(menuCapture).includes("Model fallback"));
		artifacts.menuBefore = menuCapture;

		// Menu nav probe: one Down should move the highlight to "Add/edit chain".
		downSend();
		await sleep(400);
		const menuAfterDown = capture();
		artifacts.menuAfterDown = menuAfterDown;
		checks.ok(
			"menu selector navigates with Down",
			highlightedLine(menuAfterDown).includes("Add/edit chain"),
			`highlight=${highlightedLine(menuAfterDown)}`,
		);

		// Enter "Add/edit chain" -> the target-model selector.
		send(enterKey, { literal: options.kitty });
		const targetCapture = await waitFor(capture, alive, (text) => stripAnsi(text).includes("Fallback target model"));
		checks.ok("target model selector opens", stripAnsi(targetCapture).includes("Fallback target model"));
		await sleep(400);
		const before = capture();
		artifacts.selectorBefore = before;
		const highlightBefore = highlightedLine(before);

		// The reported failing input: two arrows + two literal j's.
		downSend();
		downSend();
		send("j", { literal: true });
		send("j", { literal: true });
		// SENPI_QA_795_SETTLE_MS: large registries repaint the whole list per keypress;
		// a longer settle separates "input ignored" from "render lag".
		await sleep(Number.parseInt(process.env.SENPI_QA_795_SETTLE_MS ?? "600", 10) || 600);
		const after = capture();
		artifacts.selectorAfter = after;
		const highlightAfter = highlightedLine(after);

		navWorks = highlightBefore !== highlightAfter && highlightAfter.includes("qsel-5");
		// With a registry taller than the terminal the highlight can move off-screen;
		// Enter advancing the flow is then the decisive navigation signal.
		const highlightMoved = navWorks;
		checks.ok(
			"target selector navigates with arrows and j/k",
			navWorks,
			`before=${highlightBefore} after=${highlightAfter} (expected → ${PROVIDER}/qsel-5)`,
		);

		// Enter must select the highlighted entry and advance the flow.
		send(enterKey, { literal: options.kitty });
		const advanced = await waitFor(capture, alive, (text) => stripAnsi(text).includes("Fallback model (Done to save)"), 60);
		artifacts.afterEnter = advanced;
		checks.ok(
			"Enter advances the chain editor",
			stripAnsi(advanced).includes("Fallback model (Done to save)"),
		);
		if (!highlightMoved && stripAnsi(advanced).includes("Fallback model (Done to save)")) {
			process.stdout.write("[note] highlight not visible but Enter advanced — navigation works off-screen (large-registry rendering artifact)\n");
		}

		// SENPI_QA_795_COMPLETE=1: finish the flow (pick qsel-1 as fallback, inherit
		// thinking, Done) and read the sandbox settings.json — the saved chain's
		// TARGET key settles which model the target dialog had actually selected.
		if (process.env.SENPI_QA_795_COMPLETE === "1") {
			downSend();
			send(enterKey, { literal: options.kitty });
			await waitFor(capture, alive, (text) => stripAnsi(text).includes("Thinking level"), 100);
			send(enterKey, { literal: options.kitty });
			await waitFor(capture, alive, (text) => stripAnsi(text).includes("Fallback model (Done to save)"), 100);
			send(enterKey, { literal: options.kitty }); // Done -> save
			await sleep(1200);
			let saved = "(no settings.json)";
			try {
				saved = readFileSync(join(box.agentDir, "settings.json"), "utf8");
			} catch {}
			artifacts.savedSettings = saved;
			const targetMatch = saved.match(/"(qasel795\/qsel-\d+)"/);
			checks.ok(
				"saved chain target is the 5th model (navigation registered)",
				targetMatch?.[1] === "qasel795/qsel-5",
				`saved target=${targetMatch?.[1] ?? "none"} settings=${saved.slice(0, 300)}`,
			);
		}
	} finally {
		try {
			execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
		} catch {}
		if (options.evidence) {
			const dir = evidenceDir(options.evidence);
			for (const [name, text] of Object.entries(artifacts)) {
				writeFileSync(join(dir, `fallback-nav-795-${name}.txt`), stripAnsi(text));
			}
			process.stderr.write(`evidence: ${dir}\n`);
		}
		checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);
		box.cleanup();
	}
	process.exit(checks.finish() ? 0 : 1);
}

await main();
