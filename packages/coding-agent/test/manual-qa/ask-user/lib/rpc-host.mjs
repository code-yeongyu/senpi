#!/usr/bin/env node
/**
 * Hermetic `senpi --mode rpc --listen unix://...` host launcher for the ask-user probe.
 *
 * - per-run unix socket: /tmp/ask-user-<pid>-<rand>.sock (never the exhausted 18990-18999 ports)
 * - `env -i` style environment: only PATH plus scratch-pinned SENPI_* variables reach the child
 * - mock provider in <agentDir>/models.json backed by a fake OpenAI-completions server on an
 *   EPHEMERAL port (server.listen(0)), so concurrent QA lanes cannot collide
 * - the ask-user fixture extension is loaded with -e; its log path is env-pinned
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withTimeout } from "./rpc-socket-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(here, "..", "..", "..", "..");
export const repoRoot = resolve(packageDir, "..", "..");
export const fixturePath = join(packageDir, "test", "fixtures", "extensions", "ask-user-fixture.ts");

export function makeSandbox(label) {
	const dir = mkdtempSync(join(tmpdir(), `ask-user-${label}-`));
	const paths = { agent: join(dir, "agent"), sessions: join(dir, "sessions"), home: join(dir, "home"), work: join(dir, "work"), tmp: join(dir, "tmp") };
	for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
	return {
		...paths,
		dir,
		socketPath: `/tmp/ask-user-${process.pid}-${randomBytes(4).toString("hex")}.sock`,
		fixtureLog: join(dir, "ask-user-fixture.jsonl"),
		remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	};
}

/** `env -i` equivalent: only what the child demonstrably needs, everything else dropped. */
export function hermeticEnv(sandbox) {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: sandbox.home,
		TMPDIR: sandbox.tmp,
		SENPI_CODING_AGENT_DIR: sandbox.agent,
		SENPI_CODING_AGENT_SESSION_DIR: sandbox.sessions,
		SENPI_ASK_USER_FIXTURE_LOG: sandbox.fixtureLog,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		NO_COLOR: "1",
	};
}

export function writeMockModelsJson(agentDir, baseUrl) {
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					mock: {
						baseUrl,
						apiKey: "sk-ask-user-probe",
						api: "openai-completions",
						models: [
							{
								id: "mock-model",
								baseUrl,
								api: "openai-completions",
								contextWindow: 128000,
								maxTokens: 4096,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
}

export function writeSettings(agentDir, { timeoutMinutes }) {
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ askUser: { timeoutMinutes } }, null, 2)}\n`);
}

/** Fake OpenAI-completions SSE server on an ephemeral port; each call consumes the next scripted turn. */
export async function startFakeModel(turns) {
	let callIndex = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
				return;
			}
			const turn = turns[Math.min(callIndex, turns.length - 1)] ?? { text: "ok" };
			callIndex += 1;
			writeCompletionsSse(res, turn);
		});
	});
	await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}/v1`,
		get calls() {
			return callIndex;
		},
		stop: () => new Promise((resolveStop) => server.close(() => resolveStop())),
	};
}

function writeCompletionsSse(res, turn) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const base = { id: "chatcmpl-ask-user-probe", object: "chat.completion.chunk", created: 0, model: "mock-model" };
	const send = (delta, finish = null) =>
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	const complete = () => {
		res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	};
	send({ role: "assistant", content: "" });
	if (turn.toolCalls?.length) {
		send({
			tool_calls: turn.toolCalls.map((toolCall, index) => ({
				index,
				id: toolCall.id ?? `call_${index + 1}`,
				type: "function",
				function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args ?? {}) },
			})),
		});
		send({}, "tool_calls");
		complete();
		return;
	}
	send({ content: turn.text ?? "ok" });
	send({}, "stop");
	complete();
}

export async function spawnSenpiHost({ sandbox, turns = [{ text: "ok" }], timeoutMinutes = 30, onLog = () => {} }) {
	const model = await startFakeModel(turns);
	writeMockModelsJson(sandbox.agent, model.url);
	writeSettings(sandbox.agent, { timeoutMinutes });
	const child = spawn(
		process.execPath,
		[
			join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			join(repoRoot, "tsconfig.json"),
			join(packageDir, "src", "cli.ts"),
			"--mode",
			"rpc",
			"--listen",
			`unix://${sandbox.socketPath}`,
			"--provider",
			"mock",
			"--model",
			"mock-model",
			"--extension",
			fixturePath,
		],
		{
			cwd: sandbox.work,
			env: hermeticEnv(sandbox),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		},
	);
	child.stdout.on("data", (chunk) => onLog(`[host stdout] ${chunk.toString("utf8").trimEnd()}`));
	child.stderr.on("data", (chunk) => onLog(`[host stderr] ${chunk.toString("utf8").trimEnd()}`));
	const readiness = `senpi rpc listening on unix://${sandbox.socketPath}`;
	await withTimeout(waitForStderr(child, readiness), 40_000, "rpc host readiness");
	return { child, model };
}

function waitForStderr(child, expected) {
	let stderr = "";
	return new Promise((resolve, reject) => {
		const onData = (chunk) => {
			stderr += chunk.toString("utf8");
			if (stderr.includes(expected)) {
				child.stderr.off("data", onData);
				resolve();
			}
		};
		child.stderr.on("data", onData);
		child.once("exit", (code, signal) => reject(new Error(`host exited ${code ?? signal}: ${stderr}`)));
	});
}

export async function stopHost(child, { signal = "SIGTERM", timeoutMs = 10_000 } = {}) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	killTree(child.pid, signal);
	try {
		await withTimeout(new Promise((resolve) => child.once("exit", resolve)), timeoutMs, `host exit after ${signal}`);
	} catch {
		killTree(child.pid, "SIGKILL");
		await withTimeout(
			new Promise((resolve) => child.once("exit", resolve)),
			5_000,
			"host exit after SIGKILL",
		).catch(() => {});
	}
}

export function killTree(pid, signal) {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, signal);
	} catch {
		/* already gone */
	}
}
