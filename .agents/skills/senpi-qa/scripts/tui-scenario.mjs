/**
 * Channel 2 — scripted TUI scenarios.
 *
 * Drives a real sandboxed TUI through node-pty, with tmux as the POSIX fallback,
 * then asserts text from the captured transcript. Scenario defaults describe the
 * intended Claude SDK OAuth surface; --expect overrides them while that surface
 * is still under construction.
 *
 * Usage:
 *   node tui-scenario.mjs --scenario login-claude-sdk-oauth --evidence SLUG
 *   node tui-scenario.mjs --scenario claude-account --expect "account-a" --expect "pinned"
 *   node tui-scenario.mjs --self-test [--driver pty|tmux|auto] [--evidence SLUG]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
} from "./lib/common.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SCENARIOS = {
	"login-claude-sdk-oauth": {
		steps: [{ text: "/login", key: "Enter", waitFor: "Select authentication method:" }, { key: "Enter" }],
		assertions: [{ name: "provider row", expected: "Claude SDK OAuth (Claude Pro/Max)" }],
	},
	"claude-account": {
		steps: [{ text: "/claude-account", key: "Enter" }],
		assertions: [
			{ name: "default account row", expected: "default | login" },
			{ name: "second account row", expected: "work | import" },
			{ name: "pin state", expected: "pinned" },
		],
	},
	"dollar-invocation": {
		steps: [{ waitFor: "No models available." }, { text: "$deb", waitFor: "$debugging" }],
		assertions: [{ name: "visible skill row", expected: "$debugging" }],
	},
};

const tuiArgs = (scenario) => {
	const args = ["--no-context-files", "--approve"];
	if (scenario !== "dollar-invocation") args.push("--no-skills");
	return args;
};

function parseArgs(argv) {
	const options = { driver: "auto", expected: [] };
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i];
		if (value === "--self-test") options.selfTest = true;
		else if (value === "--scenario" || value === "--driver" || value === "--evidence" || value === "--expect") {
			const next = argv[++i];
			if (!next) throw new Error(`${value} requires a value`);
			if (value === "--scenario") options.scenario = next;
			else if (value === "--driver") options.driver = next;
			else if (value === "--evidence") options.evidence = next;
			else options.expected.push(next);
		} else if (value === "--expected") {
			const next = argv[++i];
			if (!next) throw new Error("--expected requires a JSON string array");
			const expected = JSON.parse(next);
			if (!Array.isArray(expected) || expected.some((entry) => typeof entry !== "string" || !entry)) {
				throw new Error("--expected must be a JSON array of non-empty strings");
			}
			options.expected.push(...expected);
		} else {
			throw new Error(`Unknown option: ${value}`);
		}
	}
	return options;
}

function assertionsFor(name, expected) {
	const scenario = SCENARIOS[name];
	if (!scenario) throw new Error(`Unknown scenario: ${name}`);
	return expected.length ? expected.map((entry, index) => ({ name: `custom expected string #${index + 1}`, expected: entry })) : scenario.assertions;
}

function tmuxAvailable() {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function ptyUsable() {
	try {
		const pty = (await import("node-pty")).default ?? (await import("node-pty"));
		const probe = pty.spawn(process.platform === "win32" ? "cmd.exe" : "/bin/echo", ["ok"], { cols: 40, rows: 10 });
		await new Promise((resolve) => {
			probe.onExit(resolve);
			setTimeout(resolve, 1500);
		});
		return true;
	} catch {
		return false;
	}
}

/** Matches tui-smoke's native node-pty-first, tmux-fallback driver selection. */
async function resolveDriver(requested) {
	if (requested === "tmux") return tmuxAvailable() ? "tmux" : "none";
	if (requested === "pty") return (await ptyUsable()) ? "pty" : "none";
	if (requested !== "auto") throw new Error(`Unknown driver: ${requested}`);
	if (await ptyUsable()) return "pty";
	return tmuxAvailable() ? "tmux" : "none";
}

async function waitFor(read, alive, predicate, attempts = 50) {
	let capture = "";
	for (let i = 0; i < attempts && alive(); i++) {
		await sleep(100);
		capture = read();
		if (predicate(capture)) break;
	}
	return capture;
}

async function sendSteps(steps, send, read, alive) {
	for (const step of steps) {
		if (!alive()) return;
		send(step);
		if (step.waitFor) await waitFor(read, alive, (text) => stripAnsi(text).includes(step.waitFor));
	}
}

function shq(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function seedClaudeAccountScenario(box, scenario) {
	if (scenario !== "claude-account") return;
	writeFileSync(
		join(box.agentDir, "auth.json"),
		JSON.stringify({
			"claude-sdk-oauth": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4_102_444_800_000,
				accounts: [
					{ name: "default", source: "login", access: "", refresh: "", expires: 4_102_444_800_000 },
					{ name: "work", source: "import", access: "", refresh: "", expires: 4_102_444_800_000 },
				],
				pinned: "default",
			},
		}),
		{ mode: 0o600 },
	);
}

function seedDollarInvocationScenario(box, scenario) {
	if (scenario !== "dollar-invocation") return;
	const skillDir = join(box.agentDir, "skills", "debugging");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		"---\nname: debugging\ndescription: Debug runtime failures\n---\n\n# Debugging\n\nTrace the defect.",
	);
	writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({ enableSkillCommands: true }, null, 2));
}

async function scenarioTmux(box, scenario, steps, expected) {
	const root = repoRoot();
	const session = `senpi-qa-scenario-${process.pid}`;
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
	const shell = [
		`cd ${shq(box.cwd)}`,
		`export SENPI_CODING_AGENT_DIR=${shq(box.agentDir)} SENPI_CODING_AGENT_SESSION_DIR=${shq(box.sessionDir)} HOME=${shq(box.env.HOME)} USERPROFILE=${shq(box.env.USERPROFILE)} PI_OFFLINE=1 PI_TELEMETRY=0 SENPI_OMO_LOCAL_UPDATE=0 PAGER=cat GIT_PAGER=cat`,
		`exec ${shq(process.execPath)} ${shq(tsxEntry(root))} --tsconfig ${shq(join(root, "tsconfig.json"))} ${shq(cliEntry(root))} ${tuiArgs(scenario).map(shq).join(" ")}`,
	].join("; ");
	try {
		try {
			execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
		} catch {}
		tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "34", shell);
		await waitFor(capture, alive, (text) => stripAnsi(text).trim().length > 0, 100);
		await sendSteps(steps, (step) => {
			if (step.text) tmux("send-keys", "-t", session, "-l", step.text);
			if (step.key) tmux("send-keys", "-t", session, step.key);
		}, capture, alive);
		const raw = await waitFor(capture, alive, (text) => expected.every((entry) => stripAnsi(text).includes(entry)));
		return { driver: "tmux", raw, transcript: stripAnsi(raw), survived: alive() };
	} finally {
		try {
			execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
		} catch {}
	}
}

async function scenarioPty(box, scenario, steps, expected) {
	const root = repoRoot();
	const pty = (await import("node-pty")).default ?? (await import("node-pty"));
	const term = pty.spawn(process.execPath, [tsxEntry(root), "--tsconfig", join(root, "tsconfig.json"), cliEntry(root), ...tuiArgs(scenario)], {
		name: "xterm-color",
		cols: 120,
		rows: 34,
		cwd: box.cwd,
		env: box.env,
	});
	let raw = "";
	let exited = false;
	term.onData((data) => {
		raw += data;
	});
	term.onExit(() => {
		exited = true;
	});
	try {
		await waitFor(() => raw, () => !exited, (text) => stripAnsi(text).trim().length > 0, 100);
		await sendSteps(steps, (step) => term.write(`${step.text ?? ""}${step.key === "Enter" ? "\r" : ""}`), () => raw, () => !exited);
		await waitFor(() => raw, () => !exited, (text) => expected.every((entry) => stripAnsi(text).includes(entry)));
		return { driver: "pty", raw, transcript: stripAnsi(raw), survived: !exited };
	} finally {
		try {
			term.write("\x03\x03");
			term.kill();
		} catch {}
	}
}

async function runScenario({ scenario, expected, driver, evidence }) {
	const assertions = assertionsFor(scenario, expected);
	const chosenDriver = await resolveDriver(driver);
	const checks = createChecks(`tui-scenario.mjs ${scenario}`);
	const guard = guardRealAuth();
	if (chosenDriver === "none") {
		process.stdout.write("[SKIP] no usable PTY backend (node-pty blocked and tmux absent).\n");
		checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);
		return checks.finish();
	}

	const box = makeSandbox(`tui-scenario-${scenario}`);
	let result;
	try {
		seedClaudeAccountScenario(box, scenario);
		seedDollarInvocationScenario(box, scenario);
		process.stdout.write(`driver: ${chosenDriver}\n`);
		const steps = SCENARIOS[scenario].steps;
		result =
			chosenDriver === "tmux"
				? await scenarioTmux(
						box,
						scenario,
						steps,
						assertions.map((item) => item.expected),
					)
				: await scenarioPty(
						box,
						scenario,
						steps,
						assertions.map((item) => item.expected),
					);
		checks.ok("TUI survives scripted command", result.survived, `driver=${result.driver}`);
		for (const assertion of assertions) {
			checks.ok(
				`${scenario} ${assertion.name}`,
				result.transcript.includes(assertion.expected),
				result.transcript.includes(assertion.expected) ? "" : `missing assertion: ${scenario} ${assertion.name} ${JSON.stringify(assertion.expected)}`,
			);
		}
		if (evidence) {
			const dir = evidenceDir(evidence);
			writeFileSync(join(dir, `tui-scenario-${scenario}-${result.driver}.txt`), result.transcript);
			writeFileSync(join(dir, `tui-scenario-${scenario}-${result.driver}.raw.txt`), result.raw);
			process.stderr.write(`evidence: ${dir}\n`);
		}
	} finally {
		box.cleanup();
	}
	checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);
	return checks.finish();
}

async function selfTest(options) {
	const checks = createChecks("tui-scenario.mjs --self-test");
	checks.ok("login scenario declares the Claude SDK OAuth provider row", assertionsFor("login-claude-sdk-oauth", []).some((item) => item.expected === "Claude SDK OAuth (Claude Pro/Max)"));
	checks.ok("custom expectation list replaces scenario defaults", assertionsFor("claude-account", ["account-a", "pinned"]).map((item) => item.expected).join("|") === "account-a|pinned");
	const passed = await runScenario({ ...options, scenario: "login-claude-sdk-oauth", expected: ["Select provider to configure:"] });
	checks.ok("scripted /login capture passes a known selector assertion", passed);
	return checks.finish();
}

function usage() {
	process.stdout.write(
		[
			"senpi-qa Channel 2 — scripted TUI scenarios",
			"  node tui-scenario.mjs --scenario login-claude-sdk-oauth --evidence SLUG [--expect TEXT ...]",
			"  node tui-scenario.mjs --scenario claude-account --evidence SLUG [--expect TEXT ...]",
			"  node tui-scenario.mjs --scenario dollar-invocation --evidence SLUG",
			"  node tui-scenario.mjs --self-test [--driver pty|tmux|auto] [--evidence SLUG]",
			"  --expected '[\"TEXT\", \"TEXT\"]' is a JSON-list alternative to repeated --expect.",
			"",
		].join("\n"),
	);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options.selfTest && !options.scenario) {
		usage();
		return;
	}
	if (options.selfTest && options.scenario) throw new Error("--self-test cannot be combined with --scenario");
	installCleanupHooks();
	const passed = options.selfTest ? await selfTest(options) : await runScenario(options);
	process.exit(passed ? 0 : 1);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
