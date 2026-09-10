#!/usr/bin/env node
/** Real-CLI OAuth pin regression: --self-test --expect red|green. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cliEntry, guardRealAuth, makeSandbox, repoRoot, tsxEntry } from "./lib/common.mjs";
import { hermeticEnv } from "./lib/mock-loop-support.mjs";

const root = repoRoot();
const evidence = join(root, "local-ignore/qa-evidence/20260910-pinned-compaction");
const provider = "pinned-qa";
const model = "pinned-model";
const summary = "PINNED_QA_SUMMARY_OK";
const exhausted = "QA_DEFAULT_USAGE_LIMIT_EXHAUSTED";
const deadline = () => AbortSignal.timeout(25_000);
const payloads = [
	{ id: "state", type: "get_state" },
	{ id: "prompt-before", type: "prompt", message: "PINNED_QA_BEFORE" },
	{ id: "text-before", type: "get_last_assistant_text" },
	{ id: "compact", type: "compact", customInstructions: "PINNED_QA_COMPACT" },
	{ id: "messages-compact", type: "get_messages" },
	{ id: "prompt-after", type: "prompt", message: "PINNED_QA_AFTER" },
	{ id: "text-after", type: "get_last_assistant_text" },
];

function sourceReceipt() {
	const source = readFileSync(join(root, "packages/ai/src/auth/resolve.ts"), "utf8");
	return {
		path: "packages/ai/src/auth/resolve.ts",
		sha256: createHash("sha256").update(source).digest("hex"),
		implicitPinExpression: /overrides\?\.slotName\s*\?\?\s*stored\?\.pinned/.test(source),
	};
}

function writeSse(res, text) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, finishReason = null, usage) => res.write(`data: ${JSON.stringify({
		id: "pinned-qa-response", object: "chat.completion.chunk", created: 1, model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	})}\n\n`);
	chunk({ role: "assistant", content: text });
	chunk({}, "stop", { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 });
	res.end("data: [DONE]\n\n");
}

async function run(expectation) {
	mkdirSync(evidence, { recursive: true });
	const guard = guardRealAuth();
	const box = makeSandbox("pinned-compaction-qa");
	const credentials = { default: randomUUID(), "login-6": randomUUID() };
	const receipt = {
		command: `node .agents/skills/senpi-qa/scripts/pinned-compaction-qa.mjs --self-test --expect ${expectation}`,
		expectation, startedAt: new Date().toISOString(), sourceBefore: sourceReceipt(),
		rpcInputs: [], requests: [], checks: {}, cleanup: {},
	};
	let phase = "startup";
	let child;
	let childClosed = false;
	let server;
	let lines;
	let failure;
	const bus = new EventEmitter();
	const lifetime = new AbortController();
	const onSignal = () => lifetime.abort(new Error("QA interrupted"));
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	const signal = () => AbortSignal.any([deadline(), lifetime.signal]);
	const safe = (value) => {
		let text = String(value);
		for (const secret of Object.values(credentials)) text = text.replaceAll(secret, "[redacted]");
		return text.replace(/(?:Bearer|Authorization|x-api-key)\s*[:=]?\s*[^\s,}\]]+/gi, "[redacted-header]");
	};
	const check = (name, condition) => {
		receipt.checks[name] = Boolean(condition);
		assert.ok(condition, name);
	};
	try {
		server = createServer((req, res) => {
			const chunks = [];
			req.on("error", () => lifetime.abort(new Error("local HTTP request failed")));
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				try {
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					const label = Object.keys(credentials).find((name) => req.headers.authorization === `Bearer ${credentials[name]}`) ?? "unknown";
					const status = label === "login-6" ? 200 : label === "default" ? 402 : 401;
					receipt.requests.push({
						phase, account: label, method: req.method, path: req.url, status,
						summaryReplayed: JSON.stringify(body.messages).includes(summary),
					});
					assert.equal(req.url, "/v1/chat/completions");
					assert.equal(body.model, model);
					if (status !== 200) {
						res.writeHead(status, { "content-type": "application/json" });
						res.end(JSON.stringify({ error: {
							message: label === "default" ? `${exhausted}: account usage limit exhausted` : "QA_UNKNOWN_ACCOUNT",
							type: "insufficient_quota", code: "insufficient_quota",
						} }));
						return;
					}
					const text = phase === "compact" ? summary : phase === "after" ? "PINNED_QA_AFTER_OK" : "PINNED_QA_BEFORE_OK";
					writeSse(res, text);
				} catch (error) {
					lifetime.abort(error);
					res.destroy();
				}
			});
		});
		const listening = once(server, "listening", { signal: signal() });
		server.listen(0, "127.0.0.1");
		await listening;
		const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
		const expires = Date.now() + 86_400_000;
		writeFileSync(join(box.agentDir, "auth.json"), JSON.stringify({ [provider]: {
			type: "oauth", access: credentials.default, refresh: randomUUID(), expires,
			accounts: Object.entries(credentials).map(([name, access]) => ({ name, access, refresh: randomUUID(), expires, source: "login" })),
			pinned: "login-6",
		} }), { mode: 0o600 });
		writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({
			compaction: { enabled: false, idleCompactionEnabled: false, keepRecentTokens: 40 },
			retry: { enabled: false }, disabledBuiltinExtensions: ["cache-keepalive"],
		}));
		const sessionPath = join(box.sessionDir, "history.jsonl");
		const timestamp = new Date().toISOString();
		const history = [{ type: "session", version: 3, id: randomUUID(), timestamp, cwd: box.cwd }];
		let parentId = null;
		for (let index = 0; index < 4; index++) {
			const id = randomUUID().slice(0, 8);
			const text = Array.from({ length: 64 }, (_, part) =>
				`Archived record ${index}, detail ${part}: ${createHash("sha256").update(`${index}:${part}`).digest("hex")}`).join("\n");
			const message = index % 2 === 0
				? { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
				: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(),
					api: "openai-completions", provider, model, stopReason: "stop",
					usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			history.push({ type: "message", id, parentId, timestamp, message });
			parentId = id;
		}
		writeFileSync(sessionPath, `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const extension = join(box.dir, "oauth-fixture.mjs");
		writeFileSync(extension, `export default function(pi) {
	pi.registerProvider(${JSON.stringify(provider)}, {
		baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
		models: [{ id: ${JSON.stringify(model)}, name: "Pinned QA", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		oauth: {
			name: "Synthetic QA OAuth",
			async login() { throw new Error("QA_LOGIN_FORBIDDEN"); },
			async refreshToken() { throw new Error("QA_REFRESH_UNEXPECTED"); },
			getApiKey(credential) { return credential.access; }
		}
	});
}
`);
		const sandboxEnv = hermeticEnv(box.env);
		// Allowlist prevents unknown provider keys, parent branding, proxies, NODE_OPTIONS,
		// or shell hooks from crossing the sandbox boundary.
		const env = Object.fromEntries([
			"PATH", "TMPDIR", "LANG", "LC_ALL", "HOME", "USERPROFILE",
			"SENPI_CODING_AGENT_DIR", "SENPI_CODING_AGENT_SESSION_DIR", "SENPI_OMO_LOCAL_UPDATE",
			"PI_OFFLINE", "PI_TELEMETRY",
		].filter((name) => sandboxEnv[name] !== undefined).map((name) => [name, sandboxEnv[name]]));
		Object.assign(env, { XDG_CONFIG_HOME: box.dir, XDG_CACHE_HOME: box.dir, TSX_DISABLE_CACHE: "1" });
		const argv = [tsxEntry(root), "--tsconfig", join(root, "tsconfig.json"), cliEntry(root),
			"--mode", "rpc", "--session", sessionPath, "--no-context-files", "--no-extensions", "--no-skills",
			"--extension", extension, "--provider", provider, "--model", model];
		receipt.childCommand = [process.execPath, ...argv];
		child = spawn(process.execPath, argv, { cwd: box.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		child.on("error", (error) => lifetime.abort(error));
		child.on("close", (code, exitSignal) => {
			childClosed = true;
			receipt.childExit = { code, signal: exitSignal };
			lifetime.abort(new Error("CLI closed"));
		});
		receipt.stderrBytes = 0;
		child.stderr.on("data", (chunk) => { receipt.stderrBytes += chunk.length; });
		lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			if (!line.startsWith("{")) return;
			try {
				const message = JSON.parse(line);
				bus.emit(message.type === "response" ? `response:${message.id}` : message.type, message);
			} catch (error) { lifetime.abort(error); }
		});
		const send = async (payload) => {
			const response = once(bus, `response:${payload.id}`, { signal: signal() });
			receipt.rpcInputs.push(payload);
			child.stdin.write(`${JSON.stringify(payload)}\n`);
			return (await response)[0];
		};
		const prompt = async (payload) => {
			const ended = once(bus, "agent_end", { signal: signal() });
			const [response, [event]] = await Promise.all([send(payload), ended]);
			check(`${phase} prompt accepted`, response.success === true);
			const assistants = (event.messages ?? []).filter((message) => message.role === "assistant");
			receipt[`${phase}Turn`] = {
				aborted: event.aborted === true,
				outcomes: assistants.map((message) => ({ stopReason: message.stopReason, error: message.errorMessage ? safe(message.errorMessage) : null })),
			};
			check(`${phase} prompt finished without error`, assistants.length > 0 && assistants.every((message) => message.stopReason === "stop"));
		};
		const state = await send(payloads[0]);
		check("worktree CLI selected fixture model", state.success && state.data?.model?.provider === provider && state.data.model.id === model);
		phase = "before";
		await prompt(payloads[1]);
		const beforeText = await send(payloads[2]);
		check("ordinary pinned prompt succeeded", beforeText.success && beforeText.data?.text?.includes("PINNED_QA_BEFORE_OK"));
		phase = "compact";
		const compact = await send(payloads[3]);
		receipt.compactResponse = JSON.parse(safe(JSON.stringify(compact)));
		const messages = await send(payloads[4]);
		const committed = (messages.data?.messages ?? []).some((message) => message.role === "compactionSummary" && message.summary?.includes(summary));
		receipt.compactionCommitted = committed;
		check("compacted messages RPC succeeded", messages.success === true);
		phase = "after";
		await prompt(payloads[5]);
		const afterText = await send(payloads[6]);
		check("resumed pinned prompt succeeded", afterText.success && afterText.data?.text === "PINNED_QA_AFTER_OK");
		const ordinary = receipt.requests.filter((request) => request.phase === "before" || request.phase === "after");
		check("ordinary requests only used login-6", ordinary.length === 2 && ordinary.every((request) => request.account === "login-6" && request.status === 200));
		const compactions = receipt.requests.filter((request) => request.phase === "compact");
		check("explicit compact reached localhost", compactions.length > 0);
		if (expectation === "red") {
			check("RED compaction used exhausted default", compactions.length === 1 && compactions[0].account === "default" && compactions[0].status === 402);
			// Core deliberately collapses an extension's rejection reason into a
			// generic RPC error. The HTTP receipt above proves quota exhaustion;
			// assert the machine-consumed failure flag, not the error prose.
			check("RED explicit compact failed after usage exhaustion", compact.success === false);
			check("RED did not commit compaction", !committed);
		} else {
			check("GREEN compaction only used login-6", compactions.every((request) => request.account === "login-6" && request.status === 200));
			check("GREEN explicit compact succeeded", compact.success === true && compact.data?.details?.schema === "senpi.compaction.summary.v1" && typeof compact.data?.firstKeptEntryId === "string");
			check("GREEN compaction committed", committed);
			check("GREEN compaction removed old context", compact.data.details.structuralYield.savedTokens > 0);
			check("GREEN resumed request replayed summary", ordinary.at(-1).summaryReplayed);
		}
	} catch (error) {
		failure = error;
		receipt.failure = { name: error.name, message: safe(error.message) };
	} finally {
		// Never leave the tsx supervisor or its CLI descendant alive.
		if (child?.pid) {
			try {
				const closed = childClosed ? Promise.resolve() : once(child, "close", { signal: deadline() });
				try { process.kill(-child.pid, "SIGKILL"); }
				catch (error) { if (error.code !== "ESRCH") throw error; }
				await closed;
				receipt.cleanup.cliClosed = childClosed;
				try { process.kill(-child.pid, 0); receipt.cleanup.processGroupGone = false; }
				catch (error) { if (error.code !== "ESRCH") throw error; receipt.cleanup.processGroupGone = true; }
			} catch (error) { receipt.cleanup.cliError = error.name; failure ??= error; }
		} else receipt.cleanup.cliClosed = receipt.cleanup.processGroupGone = true;
		lines?.close();
		if (server?.listening) {
			try {
				const closed = once(server, "close", { signal: deadline() });
				server.closeAllConnections();
				server.close();
				await closed;
			} catch (error) { receipt.cleanup.serverError = error.name; failure ??= error; }
		}
		receipt.cleanup.serverClosed = !server?.listening;
		box.cleanup();
		receipt.cleanup.sandboxRemoved = !existsSync(box.dir);
		try { receipt.cleanup.realAuthUntouched = guard.assertUnchanged(); }
		catch (error) { receipt.cleanup.realAuthUntouched = false; failure ??= error; }
		receipt.sourceAfter = sourceReceipt();
		receipt.checks["resolver source unchanged during run"] = receipt.sourceBefore.sha256 === receipt.sourceAfter.sha256;
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		receipt.passed = !failure && Object.values(receipt.checks).every(Boolean) &&
			["cliClosed", "processGroupGone", "serverClosed", "sandboxRemoved", "realAuthUntouched"].every((key) => receipt.cleanup[key] === true);
		receipt.finishedAt = new Date().toISOString();
		writeFileSync(join(evidence, `cli-${expectation}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
	}
	for (const [name, pass] of Object.entries(receipt.checks)) console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
	console.log(JSON.stringify({ expectation, passed: receipt.passed, cleanup: receipt.cleanup, failure: receipt.failure ?? null }));
	return receipt.passed;
}

const args = process.argv.slice(2);
const expectation = args.includes("--expect") ? args[args.indexOf("--expect") + 1] : "green";
if (!args.includes("--self-test") || !["red", "green"].includes(expectation) ||
	args.some((arg, index) => !["--self-test", "--expect"].includes(arg) && args[index - 1] !== "--expect")) {
	console.error("usage: node pinned-compaction-qa.mjs --self-test [--expect red|green]");
	process.exitCode = 2;
} else {
	try { process.exitCode = await run(expectation) ? 0 : 1; }
	catch (error) { console.error(`QA setup failed (${error.name})`); process.exitCode = 1; }
}
