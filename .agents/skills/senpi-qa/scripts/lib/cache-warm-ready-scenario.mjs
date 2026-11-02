import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	cliEntry,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	spawnCli,
	stripAnsi,
	tsxEntry,
} from "./common.mjs";
import { startFakeModelServer } from "./fake-model-server.mjs";
import { hermeticEnv, PROVIDER_ENV_KEYS, writeMockModelsJson } from "./mock-loop-support.mjs";
import { renderTerminalScreenshot } from "./terminal-screenshot.mjs";
import { startTmuxTui } from "./tmux-tui-driver.mjs";
import { buildRpcReport, collectRpc, readJsonlFile, waitForClose } from "./cache-warm-ready-rpc.mjs";

const OBJECTIVE = "qa cache-warm goal: keep watching the terminal monitor until decisive output lands";
const TURNS = [
	{ toolCalls: [{ name: "create_goal", args: { objective: OBJECTIVE } }] },
	{ text: "Goal created; the monitor watch is live." },
	{ text: "Continuation check-in: still watching." },
];
const PROMPT = "Create a goal and keep watching the monitor.";
const PROVIDER_ENV_CANARY_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

export async function runCacheWarmReadyScenario() {
	installCleanupHooks();
	const root = repoRoot();
	const guard = guardRealAuth();
	const evidence = sharedEvidenceDir(root);
	const cleanup = createCleanupState();
	const startedAt = new Date().toISOString();
	const restoreProviderCanaries = installProviderEnvCanaries();
	try {
		const rpc = await runRpcSurface({ cleanup, evidence });
		const tui = await runTuiSurface({ cleanup, evidence, root });
		guard.assertUnchanged();
		cleanup.authUnchanged = true;
		writeFileSync(
			join(evidence, "summary.json"),
			`${JSON.stringify({ pass: true, command: "node .agents/skills/senpi-qa/scripts/scenarios/cache-warm-ready-rpc-tui.mjs", startedAt, rpc, tui, evidence }, null, 2)}\n`,
		);
		process.stdout.write(`PASS cache-warm-ready-rpc-tui (evidence: ${evidence})\n`);
	} finally {
		restoreProviderCanaries();
		cleanup.providerCanariesRestored = true;
		writeFileSync(join(evidence, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
		if (Object.values(cleanup).some((done) => !done)) {
			process.stderr.write(`CLEANUP_INCOMPLETE: ${JSON.stringify(cleanup)}\n`);
			process.exitCode = 2;
		}
	}
}

function createCleanupState() {
	return {
		rpcChildExited: false,
		terminalExited: false,
		rpcServerStopped: false,
		tuiServerStopped: false,
		rpcSandboxRemoved: false,
		tuiSandboxRemoved: false,
		authUnchanged: false,
		providerCanariesRestored: false,
	};
}

function installProviderEnvCanaries() {
	const previous = new Map(PROVIDER_ENV_CANARY_KEYS.map((key) => [key, process.env[key]]));
	for (const key of PROVIDER_ENV_CANARY_KEYS) {
		process.env[key] = "senpi-qa-provider-env-canary";
	}
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

function writeMonitorFixture(box) {
	const eventLogPath = join(box.dir, "goal-monitor-events.jsonl");
	const extensionPath = join(box.dir, "goal-monitor-extension.mjs");
	writeFileSync(
		extensionPath,
		`import { appendFileSync } from "node:fs";
const eventLogPath = ${JSON.stringify(eventLogPath)};
export default function(pi) {
	pi.on("session_start", () => {
		appendFileSync(eventLogPath, JSON.stringify({
			type: "qa_env_snapshot",
			leakedProviderKeys: ${JSON.stringify(PROVIDER_ENV_KEYS)}.filter((key) => process.env[key] !== undefined)
		}) + "\\n");
		pi.events?.emit("terminal_monitor_state", { activeCount: 1 });
	});
	pi.events?.on("goal_continuation_scheduled", (data) => {
		appendFileSync(eventLogPath, JSON.stringify({ type: "goal_continuation_scheduled", observedAtMs: Date.now(), data }) + "\\n");
	});
}
`,
	);
	return { extensionPath, eventLogPath };
}

async function runRpcSurface({ cleanup, evidence }) {
	const box = makeSandbox("rpc-cache-warm-ready");
	const server = await startFakeModelServer({ turns: TURNS });
	const fixture = writeMonitorFixture(box);
	writeMockModelsJson(box.agentDir, server, "openai-completions");
	const child = spawnCli(
		["--mode", "rpc", "--no-session", "--no-context-files", "--no-skills", "--approve", "--extension", fixture.extensionPath],
		{ env: hermeticEnv(box.env), cwd: box.cwd },
	);
	const rpc = collectRpc(child);
	try {
		child.stdin.write("{not-json\n");
		const malformedResponse = await rpc.waitFor(
			(message) =>
				message.type === "response" &&
				message.command === "parse" &&
				message.success === false,
			"malformed JSONL rejection",
		);
		await rpc.send({ type: "get_state" });
		await rpc.send({ type: "set_model", provider: "mock", modelId: "mock-model" });
		await rpc.send({ type: "prompt", message: PROMPT });
		const record = await rpc.waitFor(
			(message) =>
				message.type === "entry_appended" &&
				message.entry?.customType === "goal-cache-warmup" &&
				message.entry?.data?.phase === "scheduled",
			"goal-cache-warmup scheduled entry_appended",
		);
		const report = buildRpcReport(record.entry, readJsonlFile(fixture.eventLogPath));
		const rpcEnvironment = readJsonlFile(fixture.eventLogPath).find((event) => event.type === "qa_env_snapshot");
		writeFileSync(join(evidence, "rpc-cache-warm-entry.json"), `${JSON.stringify(report, null, 2)}\n`);
		writeFileSync(join(evidence, "rpc-session.jsonl"), `${rpc.lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		if (!report.pass) throw new Error(`RPC cache-warm assertions failed: ${JSON.stringify(report.assertions)}`);
		if (!rpcEnvironment || rpcEnvironment.leakedProviderKeys.length !== 0) {
			throw new Error(`RPC provider env leaked: ${JSON.stringify(rpcEnvironment?.leakedProviderKeys ?? null)}`);
		}
		const { dueAtMs, delayMs } = report.entry.data;
		process.stdout.write(
			`[PASS] rpc: goal-cache-warmup scheduled entry appended (dueAtMs=${dueAtMs} delayMs=${delayMs} basisDeltaMs=${report.basisDeltaMs})\n`,
		);
		process.stdout.write(`[PASS] rpc: malformed JSONL rejected without terminating the process\n`);
		return {
			entryTimestamp: report.entry.timestamp,
			dueAtMs,
			delayMs,
			malformedRejected: malformedResponse.success === false,
			providerEnvIsolated: true,
		};
	} finally {
		child.kill("SIGTERM");
		await waitForClose(child);
		cleanup.rpcChildExited = child.exitCode !== null || child.signalCode !== null;
		await server.stop();
		cleanup.rpcServerStopped = !server.listening;
		box.cleanup();
		cleanup.rpcSandboxRemoved = !existsSync(box.dir);
	}
}

async function runTuiSurface({ cleanup, evidence, root }) {
	const box = makeSandbox("tui-cache-warm-ready");
	const server = await startFakeModelServer({ turns: TURNS });
	const fixture = writeMonitorFixture(box);
	writeMockModelsJson(box.agentDir, server, "openai-completions");
	const terminal = startTmuxTui({
		cwd: box.cwd,
		env: hermeticEnv(box.env),
		command: process.execPath,
		args: [
			tsxEntry(root),
			"--tsconfig",
			join(root, "tsconfig.json"),
			cliEntry(root),
			"--provider",
			"mock",
			"--model",
			"mock-model",
			"--no-context-files",
			"--no-skills",
			"--no-extensions",
			"--extension",
			fixture.extensionPath,
			"--approve",
		],
		capturePath: join(box.dir, "terminal.ansi"),
		cols: 120,
		rows: 36,
	});
	try {
		await terminal.waitFor(
			(text) => text.includes("mock-model") && text.includes("esc interrupt"),
			"interactive TUI ready",
		);
		terminal.submit(PROMPT);
		const pattern = /ready \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(\d+[smh][^)]*\)/;
		const text = await terminal.waitFor((value) => pattern.test(value), "durable cache-warm ready notice", 120_000);
		const noticeLine = text.split("\n").find((line) => pattern.test(line.trim()))?.trim();
		const raw = terminal.getRaw();
		const tuiEvents = readJsonlFile(fixture.eventLogPath);
		const tuiEnvironment = tuiEvents.find((event) => event.type === "qa_env_snapshot");
		if (!tuiEnvironment || tuiEnvironment.leakedProviderKeys.length !== 0) {
			throw new Error(`TUI provider env leaked: ${JSON.stringify(tuiEnvironment?.leakedProviderKeys ?? null)}`);
		}
		writeFileSync(join(evidence, "terminal.ansi"), raw);
		writeFileSync(join(evidence, "terminal.txt"), stripAnsi(raw));
		await renderTerminalScreenshot(root, evidence, raw);
		copyFileSync(fixture.eventLogPath, join(evidence, "tui-goal-monitor-events.jsonl"));
		process.stdout.write(`[PASS] tui: durable cache-warm notice rendered: ${noticeLine}\n`);
		process.stdout.write(`[PASS] tui: screenshot: ${join(evidence, "terminal.png")}\n`);
		return { noticeLine, providerEnvIsolated: true };
	} finally {
		cleanup.terminalExited = terminal.stop();
		await server.stop();
		cleanup.tuiServerStopped = !server.listening;
		writeFileSync(
			join(evidence, "tui-model-requests.json"),
			`${JSON.stringify(
				server.requests.map((request) => ({
					...request,
					authorization: request.authorization ? "<mock-redacted>" : null,
					apiKeyHeader: request.apiKeyHeader ? "<mock-redacted>" : null,
				})),
				null,
				2,
			)}\n`,
		);
		box.cleanup();
		cleanup.tuiSandboxRemoved = !existsSync(box.dir);
	}
}

function sharedEvidenceDir(root) {
	const commonGitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
	const dir = join(dirname(resolve(root, commonGitDir)), "local-ignore", "qa-evidence", "20260813-cache-warm-ready");
	mkdirSync(dir, { recursive: true });
	return dir;
}
