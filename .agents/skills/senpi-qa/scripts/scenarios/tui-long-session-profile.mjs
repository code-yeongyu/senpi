/**
 * Long-session TUI cost probe: seeds a session with N user/assistant pairs,
 * opens it in a real PTY under Bun (the omo native runtime), streams one
 * identical mock response, and records the CLI process CPU time consumed by
 * that turn. A CPU cost that grows with N for the same stream is an
 * O(history)-per-update cost. Run with Node (node-pty does not deliver data
 * under Bun); the CLI itself is spawned with bun.
 *
 * Usage: node scenarios/tui-long-session-profile.mjs --messages 2000 [--chunks 400] [--bytes 2000]
 */
import { createServer } from "node:http";
import { chmodSync, existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import * as common from "../lib/common.mjs";
import * as support from "../lib/mock-loop-support.mjs";

const REPO = common.repoRoot();
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const messages = Number(args[args.indexOf("--messages") + 1] || 200);
const chunks = Number(args.includes("--chunks") ? args[args.indexOf("--chunks") + 1] : 400);
const padBytes = Number(args.includes("--bytes") ? args[args.indexOf("--bytes") + 1] : 0);
const pad = padBytes > 0 ? `\n\n${"Detail paragraph with **markdown** and `code` tokens. ".repeat(Math.ceil(padBytes / 52))}` : "";
const FINAL_MARKER = "SENPI-PROFILE-FINAL-MARKER-77";

function loadNodePty() {
	const packagePath = require.resolve("node-pty/package.json");
	const helper = join(dirname(packagePath), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	if (existsSync(helper)) {
		const mode = statSync(helper).mode & 0o777;
		if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
	}
	return import("node-pty").then((m) => m.default ?? m);
}

function seedSession(path, sessionId, cwd, count) {
	const base = Date.now() - 86_400_000;
	const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(base).toISOString(), cwd })];
	let parentId = null;
	for (let i = 1; i <= count; i++) {
		const userId = `u-${i}`;
		const asstId = `a-${i}`;
		const ts = base + i * 2;
		lines.push(JSON.stringify({ type: "message", id: userId, parentId, timestamp: new Date(ts).toISOString(), message: { role: "user", content: [{ type: "text", text: `probe question ${i}: explain item ${i} in the codebase` }], timestamp: ts } }));
		lines.push(JSON.stringify({ type: "message", id: asstId, parentId: userId, timestamp: new Date(ts + 1).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `## Answer ${i}\n\nItem ${i} is handled by \`module_${i}.ts\`. Key points:\n\n- it parses the input\n- it **validates** the schema\n- it emits \`result_${i}\`\n\n\`\`\`ts\nexport function handle${i}() { return ${i}; }\n\`\`\`\n` }], api: "openai-completions", provider: "mock", model: "mock-model", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: ts + 1 } }));
		parentId = asstId;
	}
	writeFileSync(path, `${lines.join("\n")}\n`);
}

function startMock() {
	const server = createServer((request, response) => {
		const body = [];
		request.on("data", (c) => body.push(c));
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const base = { id: "chatcmpl-profile", object: "chat.completion.chunk", created: 0, model: "mock-model" };
			const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			send({ role: "assistant", content: "" });
			let i = 0;
			const timer = setInterval(() => {
				i++;
				if (i <= chunks) {
					send({ content: `chunk ${i} of streamed markdown **text** with a \`code\` span. ` });
					return;
				}
				clearInterval(timer);
				send({ content: `\n\n${FINAL_MARKER}` });
				send({}, "stop");
				response.end("data: [DONE]\n\n");
			}, 5);
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, stop: () => new Promise((d) => server.close(d)) })));
}

function cpuSeconds(pid) {
	const out = execFileSync("ps", ["-o", "cputime=,rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
	const [cputime, rss] = out.split(/\s+/);
	const parts = cputime.split(":").map(Number);
	const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
	return { cpuSeconds: seconds, rssMb: Math.round(Number(rss) / 1024) };
}

const box = common.makeSandbox("tui-long-session-profile");
const server = await startMock();
support.writeMockModelsJson(box.agentDir, server, "openai-completions");
const cwd = realpathSync(box.cwd);
const sessionId = "0199aaaa-0000-7000-8000-00000000abcd";
const sessionPath = join(box.sessionDir, `2026-09-13T00-00-01-000Z_${sessionId}.jsonl`);
seedSession(sessionPath, sessionId, cwd, messages);
const env = support.hermeticEnv({ ...box.env, PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color", COLORTERM: "truecolor" });
const pty = await loadNodePty();
const BUN = process.env.HOME + "/.bun/bin/bun";
const term = pty.spawn(BUN, [common.cliEntry(REPO), "--provider", "mock", "--model", "mock-model", "--no-extensions", "--session", sessionPath], { name: "xterm-256color", cols: 160, rows: 45, cwd, env });
let raw = "";
const waiters = new Set();
term.onData((chunk) => { raw += chunk; for (const w of [...waiters]) w(); });
const waitFor = (pred, timeoutMs, label) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`${label} timed out`)); }, timeoutMs);
	const check = () => { if (pred(common.stripAnsi(raw))) { clearTimeout(timer); waiters.delete(check); resolve(); } };
	waiters.add(check); check();
});
const boot = Date.now();
try { await waitFor((text) => text.includes("Answer " + messages) || text.includes("probe question " + messages), 60_000, "boot"); } catch (e) { writeFileSync("/tmp/ulw-ws-probe-20260913/profile-raw.txt", common.stripAnsi(raw)); console.error("boot failed; raw tail:\n" + common.stripAnsi(raw).slice(-1500)); term.kill(); await server.stop(); box.cleanup(); process.exit(1); }
await new Promise((r) => setTimeout(r, 3000));
const before = cpuSeconds(term.pid);
const bootMs = Date.now() - boot;
const t0 = Date.now();
term.write("profile this turn\r");
await waitFor((text) => text.includes(FINAL_MARKER), 180_000, "final marker");
const turnMs = Date.now() - t0;
await new Promise((r) => setTimeout(r, 1500));
const after = cpuSeconds(term.pid);
const result = { messages, chunks, padBytes, bootMs, turnMs, cpuBefore: before.cpuSeconds, cpuAfter: after.cpuSeconds, cpuTurnSeconds: Math.round((after.cpuSeconds - before.cpuSeconds) * 100) / 100, rssMbAfter: after.rssMb, ptyBytes: raw.length };
console.log(JSON.stringify(result));
term.write("\x03");
term.write("\x03");
await new Promise((r) => setTimeout(r, 1000));
term.kill();
await server.stop();
box.cleanup();
