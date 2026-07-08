/**
 * Shared TUI QA environment for the neo (Go) app.
 *
 * Boots a deterministic fake-model server in a DETACHED child (so `eval $(...)`
 * can source the exports and exit while the server keeps running), builds an
 * isolated ~/.senpi sandbox pointed at that server, and prints the `export`
 * lines every neo QA scenario sources. The server never touches a real provider
 * or the real ~/.senpi.
 *
 * Usage (from repo root):
 *   eval $(node packages/neo/qa/mock-env.mjs [--turns <preset>])
 *   ... run neo against $SENPI_CODING_AGENT_DIR / $SENPI_NEO_CLI_PATH ...
 *   kill $ULW_MOCK_PID; rm -rf "$ULW_SANDBOX"     # cleanup contract
 *
 * Presets (every one embeds a unique on-screen marker so QA polls a real
 * rendered string, never an internal event). The fake server advances one turn
 * per model call and reuses the last:
 *   plain               [{text:"ULWMARK-OK"}]                       (default)
 *   tool-then-markdown  bash tool call, then "# ULWMARK-OK" heading
 *   stream-slow         "… ULWMARK" in 6 deltas 300ms apart, then "ULWMARK-2"
 *
 * STDOUT carries ONLY the export lines; everything else goes to stderr so
 * `eval $(...)` stays clean.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEntry, makeSandbox, repoRoot } from "../../../.agents/skills/senpi-qa/scripts/lib/common.mjs";
import { writeMockModelsJson } from "../../../.agents/skills/senpi-qa/scripts/lib/mock-loop-support.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Scripted turns per preset. Markers are the strings QA asserts on screen. */
const TURN_PRESETS = {
	plain: [{ text: "ULWMARK-OK" }],
	"tool-then-markdown": [{ toolCalls: [{ name: "bash", args: { command: "ls" } }] }, { text: "# ULWMARK-OK" }],
	"stream-slow": [{ text: "… ULWMARK", chunks: 6, chunkDelayMs: 300 }, { text: "ULWMARK-2" }],
};

/** The mock provider/models both scenarios switch between (`mock-a` is default). */
const MOCK_PROVIDER = "mock";
const MOCK_API = "openai-completions";
const MOCK_API_KEY = "sk-mock-qa-7f3a";
const NEO_FLAGS = "--no-context-files --no-skills --no-extensions --approve";
const READY_TIMEOUT_MS = 15000;

function flagValue(name) {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

function fail(message) {
	process.stderr.write(`mock-env: ${message}\n`);
	process.exit(2);
}

/** Two models, both aimed at the fake server, so `/model` proves a real switch. */
function writeTwoModelConfig(agentDir, baseUrl) {
	const model = (id) => ({
		id,
		baseUrl,
		api: MOCK_API,
		contextWindow: 128000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const config = {
		providers: {
			[MOCK_PROVIDER]: { baseUrl, apiKey: MOCK_API_KEY, api: MOCK_API, models: [model("mock-a"), model("mock-b")] },
		},
	};
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(config, null, 2));
}

/** Resolve when the child prints its `READY {json}` line; reject on timeout/exit. */
function waitForReady(child) {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`fake server did not report ready within ${READY_TIMEOUT_MS}ms`));
		}, READY_TIMEOUT_MS);
		const onData = (chunk) => {
			buffer += chunk.toString();
			const line = buffer.split("\n").find((l) => l.startsWith("READY "));
			if (!line) return;
			cleanup();
			try {
				resolve(JSON.parse(line.slice("READY ".length)));
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const onExit = (code) => {
			cleanup();
			reject(new Error(`fake server child exited early (code ${code})`));
		};
		function cleanup() {
			clearTimeout(timer);
			child.stdout.off("data", onData);
			child.off("exit", onExit);
		}
		child.stdout.on("data", onData);
		child.on("exit", onExit);
	});
}

async function main() {
	const preset = flagValue("--turns") ?? "plain";
	const turns = TURN_PRESETS[preset];
	if (!turns) fail(`unknown --turns "${preset}". valid: ${Object.keys(TURN_PRESETS).join(", ")}`);

	const box = makeSandbox("neo-mock-env");
	const logPath = join(box.dir, "requests.log");

	const child = spawn(process.execPath, [join(__dirname, "mock-env-child.mjs")], {
		detached: true,
		stdio: ["ignore", "pipe", "inherit"],
		env: { ...process.env, MOCK_ENV_TURNS: JSON.stringify(turns), MOCK_ENV_LOG: logPath },
	});

	let ready;
	try {
		ready = await waitForReady(child);
	} catch (error) {
		try {
			process.kill(child.pid);
		} catch {}
		box.cleanup();
		fail(error instanceof Error ? error.message : String(error));
	}

	// writeMockModelsJson writes one model; overwrite with the two-model config.
	writeMockModelsJson(box.agentDir, { url: ready.url, origin: ready.origin, port: ready.port }, MOCK_API);
	writeTwoModelConfig(box.agentDir, ready.url);

	const exports = [
		`export SENPI_CODING_AGENT_DIR=${box.agentDir}`,
		`export SENPI_CODING_AGENT_SESSION_DIR=${box.sessionDir}`,
		`export SENPI_NEO_CLI_PATH=${cliEntry(repoRoot())}`,
		`export ULW_MOCK_PID=${child.pid}`,
		`export ULW_MOCK_PORT=${ready.port}`,
		`export ULW_MOCK_LOG=${logPath}`,
		`export ULW_SANDBOX=${box.dir}`,
		`export ULW_NEO_FLAGS='${NEO_FLAGS}'`,
	];
	process.stdout.write(`${exports.join("\n")}\n`);

	// Detach so the server outlives this parent; drop the pipe so we exit cleanly
	// WITHOUT cleaning up the sandbox (the QA caller owns cleanup via ULW_*).
	child.unref();
	child.stdout.destroy();
}

main().catch((error) => {
	process.stderr.write(`mock-env: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
