#!/usr/bin/env node
/**
 * Real-surface QA for issue #793: the shipped claude-fable-5 fallback chain
 * must expand to providers that expose Kimi K3 as `kimi-k3` (e.g. OpenCode Go).
 *
 * Drives the REAL interactive CLI in a tmux-backed sandbox whose models.json
 * registers one provider `opencode-go` serving claude-fable-5, k3, kimi-k3,
 * claude-opus-5 and claude-opus-4-8, opens `/fallback` -> "Show chains & live
 * state", and asserts the canonical chain contains `opencode-go/kimi-k3:max`.
 *
 * Binary observable:
 *   - chain display CONTAINS opencode-go/kimi-k3:max  -> fixed
 *   - chain display OMITS  opencode-go/kimi-k3:max    -> bug present (RED)
 *
 * Usage: node fallback-chains-kimi-k3-qa.mjs [--evidence SLUG]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

function parseArgs(argv) {
	const options = { evidence: undefined };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--evidence") {
			const next = argv[++i];
			if (!next) throw new Error("--evidence requires a value");
			options.evidence = next;
		} else {
			throw new Error(`Unknown option: ${argv[i]}`);
		}
	}
	return options;
}

function seedModels(box) {
	const model = (id) => ({
		id,
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const config = {
		providers: {
			"opencode-go": {
				baseUrl: "http://127.0.0.1:9/v1", // never contacted: no turn is driven
				apiKey: "qa-chains-key",
				api: "openai-completions",
				models: ["claude-fable-5", "k3", "kimi-k3", "claude-opus-5", "claude-opus-4-8"].map(model),
			},
		},
	};
	writeFileSync(join(box.agentDir, "models.json"), JSON.stringify(config, null, 2));
}

function shq(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
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
	const checks = createChecks("fallback-chains-kimi-k3-qa");
	const guard = guardRealAuth();
	installCleanupHooks();
	const root = repoRoot();
	const box = makeSandbox("fallback-chains-793");
	seedModels(box);

	const session = `senpi-qa-793-${process.pid}`;
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

	const shell = [
		`cd ${shq(box.cwd)}`,
		`unset ${PROVIDER_ENV_KEYS.join(" ")}`,
		`export SENPI_CODING_AGENT_DIR=${shq(box.agentDir)} SENPI_CODING_AGENT_SESSION_DIR=${shq(box.sessionDir)} PI_OFFLINE=1 PI_TELEMETRY=0`,
		`exec ${shq(process.execPath)} ${shq(tsxEntry(root))} --tsconfig ${shq(join(root, "tsconfig.json"))} ${shq(cliEntry(root))} --no-context-files --no-skills --approve`,
	].join("; ");

	const artifacts = {};
	try {
		try {
			execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
		} catch {}
		tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "34", shell);

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

		send("/fallback", { literal: true });
		send("Enter");
		const menu = await waitFor(capture, alive, (text) => stripAnsi(text).includes("Model fallback"));
		checks.ok("fallback menu opens", stripAnsi(menu).includes("Model fallback"));

		// First menu entry is "Show chains & live state" — no navigation needed.
		send("Enter");
		const chains = await waitFor(capture, alive, (text) => stripAnsi(text).includes("opencode-go/claude-fable-5"));
		artifacts.chains = chains;
		const plain = stripAnsi(chains);
		checks.ok("canonical fable chain renders", plain.includes("opencode-go/claude-fable-5"), plain.slice(0, 400));
		checks.ok(
			"chain includes opencode-go/kimi-k3:max (issue #793)",
			plain.includes("opencode-go/kimi-k3:max"),
			plain.includes("opencode-go/kimi-k3:max") ? "" : `chain text: ${plain.slice(0, 600)}`,
		);
		checks.ok("chain still includes opencode-go/k3:max", plain.includes("opencode-go/k3:max"));
	} finally {
		try {
			execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
		} catch {}
		if (options.evidence) {
			const dir = evidenceDir(options.evidence);
			for (const [name, text] of Object.entries(artifacts)) {
				writeFileSync(join(dir, `fallback-chains-793-${name}.txt`), stripAnsi(text));
			}
			process.stderr.write(`evidence: ${dir}\n`);
		}
		checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);
		box.cleanup();
	}
	process.exit(checks.finish() ? 0 : 1);
}

await main();
