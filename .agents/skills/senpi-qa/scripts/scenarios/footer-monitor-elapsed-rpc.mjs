/**
 * QA scenario (criterion 1 SURFACE): monitor footer status shows LIVE elapsed
 * time, observed through the senpi RPC extension_ui_request setStatus bridge.
 *
 * Drives the REAL CLI (--mode rpc) against the deterministic fake model server:
 * turn 1 executes the monitor tool (persistent sleep), turn 2 waits ~6s before
 * answering so the footer ticker publishes advancing (Ns) labels.
 *
 * PASS = >=2 monitors setStatus notifications with distinct (Ns) labels.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { guardRealAuth, installCleanupHooks, makeSandbox, spawnCli } from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

const outDir = process.argv[2] ?? join(process.cwd(), "..", "..", "..", "..", "..", "local-ignore", "qa-evidence", "20260731-footer-elapsed");
mkdirSync(outDir, { recursive: true });

guardRealAuth();
installCleanupHooks();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await startFakeModelServer({
	turns: [
		{ toolCalls: [{ name: "monitor", args: { description: "qa elapsed watch", command: "sleep 30", persistent: true } }] },
		{ text: "watch is live", chunks: 4, chunkDelayMs: 1800 },
	],
});

const sandbox = makeSandbox("rpc-monitor-elapsed");
const env = hermeticEnv(sandbox.env);
writeMockModelsJson(sandbox.agentDir, server, "openai-completions");

const child = spawnCli(["--mode", "rpc", "--no-session", "--no-context-files"], { env, cwd: sandbox.cwd });

let buf = "";
const lines = [];
const setStatusEvents = [];
const responses = new Map();
let seq = 0;
let stderr = "";

child.stdout.on("data", (chunk) => {
	buf += chunk.toString();
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		lines.push(line);
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg.type === "response" && msg.id !== undefined) {
			const w = responses.get(msg.id);
			if (w) { responses.delete(msg.id); w(msg); }
		}
		if (msg.type === "extension_ui_request" && msg.method === "setStatus") {
			setStatusEvents.push({ at: Date.now(), key: msg.statusKey, text: msg.statusText });
		}
	}
});
child.stderr.on("data", (d) => { stderr += d.toString(); });

function send(cmd, timeoutMs = 90000) {
	const id = `req-${++seq}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout ${cmd.type}: ${stderr.slice(-300)}`)), timeoutMs);
		responses.set(id, (m) => { clearTimeout(timer); resolve(m); });
		child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
	});
}

try {
	await send({ type: "get_state" });
	await send({ type: "set_model", provider: "mock", modelId: "mock-model" });
	await send({ type: "prompt", message: "start the qa elapsed watch and confirm" }, 120000);
	// let the ticker keep publishing after the turn ends
	await sleep(3000);

	const monitorStatuses = setStatusEvents.filter((e) => e.key === "monitors" && typeof e.text === "string");
	const elapsed = monitorStatuses.map((e) => {
		const m = e.text.match(/\((\d+)(s|m|h)\)/);
		return m ? { at: e.at, label: m[0], text: e.text } : null;
	}).filter(Boolean);
	const distinct = [...new Set(elapsed.map((e) => e.label))];
	const pass = elapsed.length >= 2 && distinct.length >= 2;

	const report = {
		pass,
		monitorStatusCount: monitorStatuses.length,
		distinctElapsedLabels: distinct,
		elapsedTimeline: elapsed.map((e) => e.text),
		allStatusKeys: [...new Set(setStatusEvents.map((e) => e.key))],
	};
	writeFileSync(join(outDir, "rpc-monitor-elapsed.json"), JSON.stringify(report, null, 2) + "\n");
	writeFileSync(join(outDir, "rpc-monitor-elapsed.jsonl"), lines.join("\n") + "\n");
	console.log(JSON.stringify(report, null, 2));
	child.kill("SIGTERM");
	await server.stop();
	await sleep(400);
	process.exit(pass ? 0 : 1);
} catch (err) {
	writeFileSync(join(outDir, "rpc-monitor-elapsed-error.txt"), `${err.stack}\nSTDERR:\n${stderr}\n`);
	console.error("SCENARIO_ERROR:", err.message);
	child.kill("SIGKILL");
	await server.stop();
	process.exit(2);
}
