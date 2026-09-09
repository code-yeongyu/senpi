import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
	evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli,
} from "../lib/common.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

const primary = "mock-claude";
const fallback = "mock-claude-fallback";
const final = "MID_OUTPUT_RECOVERED";
installCleanupHooks();
const guard = guardRealAuth();
const evidence = evidenceDir("anthropic-mid-output-wire");

function block(index, content) {
	return [
		{ type: "content_block_start", index, content_block: content.type === "text" ? { ...content, text: "" } : content },
		...(content.type === "text"
			? [{ type: "content_block_delta", index, delta: { type: "text_delta", text: content.text } }]
			: []),
		{ type: "content_block_stop", index },
	];
}

function responseEvents(model, first, sentinel) {
	const events = [{
		type: "message_start",
		message: {
			id: "msg_wire", type: "message", role: "assistant", model, content: [],
			stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	}];
	if (first) {
		events.push(...block(0, { type: "text", text: "Discarded attempt. " }));
		events.push(
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "abandoned", name: "bash", input: {} } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: `touch '${sentinel}'` }) } },
			{ type: "content_block_stop", index: 1 },
			...block(2, { type: "fallback", from: { model: primary }, to: { model: "mock-server-substitute" } }),
		);
	}
	events.push(
		...block(first ? 3 : 0, { type: "text", text: final }),
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	);
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function hasFallback(value) {
	if (!value || typeof value !== "object") return false;
	return value.type === "fallback" || Object.values(value).some(hasFallback);
}

for (const abort of [true, false]) {
	const box = makeSandbox("senpi-mid-output-wire");
	const sentinel = join(box.cwd, "abandoned-tool-ran");
	const requests = [];
	const server = createServer(async (request, response) => {
		try {
			let body = "";
			for await (const chunk of request) body += chunk;
			const payload = JSON.parse(body);
			requests.push({ model: payload.model, fallbackInInput: hasFallback(payload.messages) });
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(responseEvents(payload.model, requests.length === 1, sentinel));
		} catch {
			response.writeHead(500);
			response.end();
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	const label = abort ? "abort" : "continue";
	try {
		writeMockModelsJson(box.agentDir, { origin }, "anthropic-messages", {}, {
			models: [{ id: fallback }],
			retry: {
				enabled: true, maxRetries: 2, baseDelayMs: 0, abortServerSideFallback: abort,
				provider: { maxRetries: 0 },
				fallbackChains: { [`anthropic/${primary}`]: [`anthropic/${fallback}`] },
			},
		});
		const args = ["--provider", "anthropic", "--model", primary, "--print", "--no-extensions"];
		const env = hermeticEnv(box.env);
		for (const key of Object.keys(env)) {
			if (key.endsWith("_PACKAGE_DIR")) delete env[key];
		}
		const result = await runCli([...args, "Return the scripted final marker."], {
			env, cwd: box.cwd, timeoutMs: 60000,
		});
		writeFileSync(join(evidence, `${label}-stdout.txt`), result.stdout);
		writeFileSync(join(evidence, `${label}-stderr.txt`), result.stderr);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.timedOut, false);
		assert(result.stdout.includes(final));
		assert(!`${result.stdout}${result.stderr}`.includes("unsupported mid-output"));
		assert.deepEqual(requests.map((item) => item.model), abort ? [primary, fallback] : [primary]);
		assert.equal(existsSync(sentinel), false, "abandoned tool must not run");
		const logPath = join(box.agentDir, "logs", "fallback.log");
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		const rows = log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.equal(rows.some((row) => row.event === "cooldown_noted"), false);
		if (abort) assert(rows.some((row) => row.event === "fallback_applied" && row.reason === "refusal"));
		writeFileSync(join(evidence, `${label}-fallback.log`), log);
		const next = await runCli([...args, "--continue", "Return the next scripted marker."], {
			env, cwd: box.cwd, timeoutMs: 60000,
		});
		assert.equal(next.code, 0, next.stderr);
		assert(next.stdout.includes(final));
		assert(requests.length > (abort ? 2 : 1));
		assert.equal(requests.some((item) => item.fallbackInInput), false);
		writeFileSync(join(evidence, `${label}-requests.json`), JSON.stringify(requests, null, 2));
		guard.assertUnchanged();
		console.log(`PASS ${label}: marker returned, abandoned tools=0, cooldown=0, replay markers=0`);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		box.cleanup();
		assert.equal(server.listening, false);
		assert.equal(existsSync(box.dir), false);
		writeFileSync(join(evidence, `${label}-cleanup.json`), JSON.stringify({
			serverListening: server.listening, sandboxExists: existsSync(box.dir), authUnchanged: guard.assertUnchanged(),
		}));
	}
}
console.log(`PASS evidence=${evidence}`);
