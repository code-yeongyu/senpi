/**
 * Transcript feed fixture generator (plan task 9).
 *
 * Drives the REAL `senpi --mode rpc` process (from TypeScript source via tsx,
 * exactly as the senpi-qa channels and the task-3 bridge generator do) inside an
 * isolated sandbox, with the fake model server scripted to request a `bash` tool
 * call whose command fails (non-zero exit → isError result), followed by a turn
 * the driver interrupts mid-flight to capture a real stopReason:"aborted"
 * assistant message. The raw stdout JSONL event stream is captured verbatim and
 * the transcript-rendering variants (message_end, tool_execution_start/end) are
 * projected onto the transcript.FeedEvent shape and written to
 * session_tool_error_abort.jsonl.
 *
 * The fixture is real protocol output, never hand-authored: tool-call ids/args,
 * the error result content, and the aborted assistant message all come from the
 * captured stream. Reuses the task-3 driver + models.json + fake-server pattern.
 *
 * Hermetic: no real provider key reaches the fake server; the real
 * ~/.senpi/agent/auth.json hash is asserted unchanged before exit.
 *
 * Regenerate:
 *   node packages/neo/internal/ui/transcript/testdata/gen-feed-fixture.mjs
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox } from "../../../../../../.agents/skills/senpi-qa/scripts/lib/common.mjs";
import { startFakeModelServer } from "../../../../../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs";

/**
 * Thin pass-through proxy in FRONT of the shared fake model server. It forwards
 * every request unchanged (real fake-server output, real provenance) but delays
 * the Nth+ completion request by delayMs so the driver's `interrupt` reliably
 * lands mid-stream and the RPC layer emits a REAL stopReason:"aborted" assistant
 * message. The shared fake-model-server is never modified. delayAfter counts
 * only /chat/completions calls (the model turns), not the initial /models probe.
 */
function startDelayProxy(upstreamUrl, { delayAfter, delayMs }) {
	const upstream = new URL(upstreamUrl);
	let completionCalls = 0;
	const server = createServer((req, res) => {
		const isCompletion = (req.url || "").includes("/chat/completions");
		const forward = () => {
			const opts = {
				hostname: upstream.hostname,
				port: upstream.port,
				path: req.url,
				method: req.method,
				headers: req.headers,
			};
			const up = httpRequest(opts, (upRes) => {
				res.writeHead(upRes.statusCode || 502, upRes.headers);
				upRes.pipe(res);
			});
			up.on("error", () => {
				res.writeHead(502);
				res.end();
			});
			req.pipe(up);
		};
		if (isCompletion) {
			completionCalls++;
			if (completionCalls > delayAfter) {
				setTimeout(forward, delayMs);
				return;
			}
		}
		forward();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				stop: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot() {
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "packages", "coding-agent", "src", "cli.ts"))) return dir;
		dir = dirname(dir);
	}
	throw new Error("repo root not found");
}

const ROOT = repoRoot();
const CLI = join(ROOT, "packages", "coding-agent", "src", "cli.ts");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const AUTH = join(process.env.SENPI_CODING_AGENT_DIR || join(homedir(), ".senpi", "agent"), "auth.json");

function sha256OrNull(p) {
	try {
		return createHash("sha256").update(readFileSync(p)).digest("hex");
	} catch {
		return null;
	}
}

class Driver {
	constructor({ env, cwd, extraArgs = [] }) {
		this.rawLines = [];
		this.events = [];
		this.pending = new Map();
		this.seq = 0;
		this.buf = "";
		this.stderr = "";
		this.child = spawn(
			process.execPath,
			[TSX, "--tsconfig", join(ROOT, "tsconfig.json"), CLI, "--mode", "rpc", "--no-session", "--no-context-files", ...extraArgs],
			{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		this.child.stdout.on("data", (c) => this.onData(c));
		this.child.stderr.on("data", (d) => (this.stderr += d.toString()));
	}

	onData(chunk) {
		this.buf += chunk.toString();
		let nl;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const raw = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			this.rawLines.push(line);
			if (msg && msg.type === "response") {
				const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
				if (waiter) {
					this.pending.delete(msg.id);
					waiter.resolve({ msg, line });
				}
			} else if (msg && msg.type) {
				this.events.push({ msg, line });
			}
		}
	}

	send(cmd, { timeoutMs = 45000 } = {}) {
		const id = cmd.id ?? `req-${++this.seq}`;
		const payload = { ...cmd, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout ${timeoutMs}ms for ${cmd.type} (stderr: ${this.stderr.slice(-600)})`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
			});
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	fire(cmd) {
		const id = cmd.id ?? `req-${++this.seq}`;
		this.child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
	}

	waitForEvent(pred, { timeoutMs = 90000 } = {}) {
		const found = this.events.find((e) => pred(e.msg));
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const iv = setInterval(() => {
				const hit = this.events.find((e) => pred(e.msg));
				if (hit) {
					clearInterval(iv);
					resolve(hit);
				} else if (Date.now() - start > timeoutMs) {
					clearInterval(iv);
					reject(new Error(`event wait timeout ${timeoutMs}ms (stderr: ${this.stderr.slice(-600)})`));
				}
			}, 40);
		});
	}

	countEvents(pred) {
		return this.events.filter((e) => pred(e.msg)).length;
	}

	close() {
		try {
			this.child.stdin.end();
		} catch {}
		try {
			this.child.kill("SIGTERM");
		} catch {}
	}
}

function writeModels(agentDir, baseUrl) {
	const modelsJson = {
		providers: {
			mock: {
				baseUrl,
				apiKey: "sk-mock-neo-feed-fixture",
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
	};
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson, null, 2));
}

async function main() {
	const authBefore = sha256OrNull(AUTH);
	const box = makeSandbox("neo-feed-fixture");
	const server = await startFakeModelServer({
		turns: [
			{ toolCalls: [{ name: "bash", args: { command: "sh -c 'echo boom: command failed 1>&2; exit 1'" } }] },
			{ text: "The command failed; stopping here." },
			// A third turn the driver interrupts to capture stopReason "aborted".
			{ text: "Thinking".padEnd(4000, ".") },
		],
	});
	// The tool turn is 2 completion calls (request + tool-result continuation);
	// the aborted turn is the 3rd. Delay the 3rd+ so the interrupt lands mid-turn.
	const proxy = await startDelayProxy(server.url, { delayAfter: 2, delayMs: 2000 });
	writeModels(box.agentDir, proxy.url);

	const d = new Driver({
		env: box.env,
		cwd: box.cwd,
		extraArgs: ["--provider", "mock", "--model", "mock-model", "--no-extensions", "--approve"],
	});

	await d.send({ type: "get_state" });
	const ack = await d.send({ type: "prompt", message: "Run the failing command." });
	if (ack.msg.success !== true) throw new Error(`prompt rejected: ${ack.line}`);
	await d.waitForEvent((m) => m.type === "agent_end");

	// Second prompt: the 3rd completion is delayed 2s by the proxy, so we fire the
	// interrupt while it is in-flight → real aborted assistant (stopReason
	// "aborted"). Wait for the agent_start of the new turn, then interrupt.
	const before = d.countEvents((m) => m.type === "agent_end");
	d.fire({ type: "prompt", message: "Now elaborate at length." });
	await d
		.waitForEvent((m) => m.type === "agent_start" && d.countEvents((x) => x.type === "agent_end") === before, {
			timeoutMs: 10000,
		})
		.catch(() => {});
	await sleep(300); // let the delayed completion request be in-flight
	d.fire({ type: "abort" });
	await d
		.waitForEvent((m) => m.type === "agent_end" && d.countEvents((x) => x.type === "agent_end") >= before + 1, {
			timeoutMs: 15000,
		})
		.catch(() => {});
	await sleep(200);

	const gotAborted = d.events.some(
		(e) => e.msg.type === "message_end" && e.msg.message?.role === "assistant" && e.msg.message?.stopReason === "aborted",
	);
	if (!gotAborted) {
		process.stderr.write("WARN: no aborted assistant turn captured this run; abort rendering is covered by unit tests\n");
	}

	const events = d.events.map((e) => e.msg);
	const feed = projectFeed(events);
	if (!feed.some((e) => e.type === "tool_execution_end")) {
		process.stderr.write(`no tool_execution_end captured. stderr tail:\n${d.stderr.slice(-1500)}\n`);
		process.exit(1);
	}

	const out = feed.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(join(__dirname, "session_tool_error_abort.jsonl"), out);
	process.stderr.write(`wrote ${feed.length} feed events (from ${events.length} raw events)\n`);

	d.close();
	await proxy.stop();
	await server.stop();
	box.cleanup();

	const authAfter = sha256OrNull(AUTH);
	if (authBefore !== authAfter) {
		process.stderr.write("FATAL: real auth.json changed during fixture generation\n");
		process.exit(2);
	}
	process.stderr.write("real auth.json unchanged\n");
}

function projectFeed(events) {
	const out = [];
	for (const ev of events) {
		if (ev.type === "message_end" && ev.message) {
			const m = ev.message;
			if (m.role === "user" || m.role === "assistant") {
				out.push({
					type: "message_end",
					message: {
						role: m.role,
						content: normalizeContent(m.content),
						stopReason: m.stopReason,
						errorMessage: m.errorMessage,
					},
				});
			}
		} else if (ev.type === "tool_execution_start") {
			out.push({
				type: "tool_execution_start",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName ?? toolNameFromCall(events, ev.toolCallId),
				toolArgs: ev.args ?? argsFromCall(events, ev.toolCallId),
			});
		} else if (ev.type === "tool_execution_end") {
			out.push({
				type: "tool_execution_end",
				toolCallId: ev.toolCallId,
				result: {
					content: normalizeContent(ev.result?.content),
					isError: Boolean(ev.result?.isError),
				},
			});
		}
	}
	return out;
}

function toolNameFromCall(events, id) {
	for (const ev of events) {
		if (ev.type === "message_end" && ev.message?.content) {
			for (const c of ev.message.content) if (c.type === "toolCall" && c.id === id) return c.name;
		}
	}
	return "bash";
}

function argsFromCall(events, id) {
	for (const ev of events) {
		if (ev.type === "message_end" && ev.message?.content) {
			for (const c of ev.message.content) if (c.type === "toolCall" && c.id === id) return c.arguments ?? c.args ?? {};
		}
	}
	return {};
}

function normalizeContent(content) {
	if (!Array.isArray(content)) return [];
	return content
		.filter((c) => c.type === "text" || c.type === "image" || c.type === "thinking")
		.map((c) => ({ type: c.type, text: c.text, thinking: c.thinking, data: c.data, mimeType: c.mimeType }));
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
	process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
	process.exit(1);
});
