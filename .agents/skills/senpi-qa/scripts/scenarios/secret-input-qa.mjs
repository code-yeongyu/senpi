import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cliEntry, evidenceDir, guardRealAuth, makeSandbox, resolveBun } from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { RpcClient } from "../lib/rpc-client.mjs";

// The sentinel is generated only in this process. Neither command arguments nor fixture source contains it.
function variants(value) {
	const roots = new Set([value, value.trim(), value.trim().slice(0, 16), value.trim().slice(-16)]);
	return [...new Set([...roots].flatMap((root) => [root, JSON.stringify(root).slice(1, -1),
		Buffer.from(root).toString("base64"), Buffer.from(root).toString("base64url"),
		Buffer.from(root).toString("hex"), encodeURIComponent(root)]))];
}
function scan(outputs, value) {
	const needles = variants(value);
	return Object.entries(outputs).filter(([, text]) => needles.some((needle) => text.includes(needle))).map(([name]) => name);
}
function files(root, excluded) {
	const result = {};
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && path !== excluded) result[relative(root, path)] = readFileSync(path).toString();
		}
	};
	visit(root);
	return result;
}
function deadline(promise, label, ms = 45000) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms);
	})]).finally(() => clearTimeout(timer));
}
function fixture(box) {
	const path = join(box.dir, "secret-fixture.mjs");
	writeFileSync(path, `
import { writeFileSync, appendFileSync } from "node:fs";
export default function(pi) {
 pi.on("session_start", (_event, ctx) => {
  ctx.ui.onTerminalInput((data) => { appendFileSync(${JSON.stringify(join(box.dir, "terminal-listener.log"))}, data); });
  ctx.ui.notify("SECRET_QA_READY");
 });
 pi.registerCommand("secret-qa", {description:"synthetic private input QA", handler:async (_args, ctx) => {
  try {
   const value = await ctx.ui.input("SECRET_QA_FIELD", undefined, {secret:true, timeout:30000});
   if (value !== undefined) writeFileSync(${JSON.stringify(join(box.dir, "private-callback"))}, value, {mode:0o600, flag:"wx"});
   ctx.ui.notify(value === undefined ? "SECRET_QA_CANCELLED" : "SECRET_QA_CONSUMED");
  } catch (error) { ctx.ui.notify(error?.code === "secret_input_unavailable" ? "SECRET_QA_REFUSED" : "SECRET_QA_FAILED"); }
 }});
}`);
	return path;
}
function environment(box, stage) {
	const env = hermeticEnv(box.env);
	for (const key of Object.keys(env)) if (key.startsWith("SENPI_RPC_HOST_") || key.startsWith("SENPI_RPC_INTERNAL_KEY")) delete env[key];
	return { ...env, QA_SECRET_STAGE: stage, QA_INPUT_SPY: join(box.dir, "terminal-listener.log") };
}

async function rpc() {
	const box = makeSandbox("secret-rpc-qa");
	const stage = join(box.dir, "private-callback");
	const sentinel = ` ${randomUUID()}-"\\-\u00e9 `;
	const client = new RpcClient({ env: environment(box, stage), cwd: box.cwd,
		extraArgs: ["--no-extensions", "--no-skills", "--extension", fixture(box)] });
	const closed = once(client.child, "close");
	try {
		await client.send({ type: "get_state" });
		await client.send({ type: "set_client_info", width: 80, capabilities: ["interactive_user", "secret_input_v1"] });
		await client.send({ type: "append_user_message", content: "Synthetic QA transcript anchor" });
		const asked = client.waitForEvent((r) => r.type === "extension_ui_request" && r.method === "input");
		const prompt = client.send({ type: "prompt", message: "/secret-qa" });
		const request = await asked;
		assert.equal(request.secret, true);
		const consumed = client.waitForEvent((r) => r.message === "SECRET_QA_CONSUMED" || r.message === "SECRET_QA_FAILED");
		const settled = client.waitForEvent((r) => r.type === "secret_input_settled" && r.id === request.id);
		const answerId = randomUUID();
		const response = await client.send({ type: "extension_ui_response", uiRequestId: request.id, answerId,
			secret: true, value: sentinel });
		assert.equal(response.disposition, "applied");
		assert.equal((await consumed).message, "SECRET_QA_CONSUMED", "private fixture consumer failed");
		assert.equal(readFileSync(stage, "utf8") === sentinel, true, "callback exact bytes");
		assert.equal(statSync(stage).mode & 0o777, 0o600);
		assert.equal((await settled).outcome, "answered");
		await prompt;
		const state = await client.send({ type: "get_state" });
		assert.equal(state.data.answeredUiRequests.some((r) => r.answerId === answerId), true);
		const messages = await client.send({ type: "get_messages" });
		const exported = await client.send({ type: "export_html", outputPath: join(box.dir, "transcript.html") });
		assert.equal(exported.success, true);
		assert.equal(typeof state.data.sessionFile, "string");
		const entries = await client.send({ type: "get_entries" });
		const userEntry = entries.data.entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
		assert.equal(typeof userEntry?.id, "string", "fork anchor exists");
		assert.equal((await client.send({ type: "fork", entryId: userEntry.id })).success, true);
		await client.send({ type: "append_user_message", content: "Synthetic post-fork anchor" });
		const forkState = await client.send({ type: "get_state" });
		assert.equal(forkState.data.answeredUiRequests.some((r) => r.answerId === answerId), false);
		// Parser diagnostics must not reflect a malformed, sensitive JSON fragment.
		const parsed = new Promise((resolve) => {
			const original = client._onData.bind(client);
			client._onData = (chunk) => { original(chunk); if (client.responses.some((r) => r.command === "parse")) resolve(); };
		});
		client.child.stdin.write(`{"type":"extension_ui_response","value":${JSON.stringify(sentinel)} BROKEN}\n`);
		await deadline(parsed, "parse refusal");
		client.close();
		await deadline(closed, "RPC close");
		const resumed = new RpcClient({ env: environment(box, stage), cwd: box.cwd,
			extraArgs: ["--no-extensions", "--no-skills", "--session", forkState.data.sessionFile, "--extension", fixture(box)] });
		const resumedClosed = once(resumed.child, "close");
		let resumedState;
		try {
			resumedState = await resumed.send({ type: "get_state" });
			assert.equal(resumedState.data.answeredUiRequests.some((r) => r.answerId === answerId), false);
		} finally {
			resumed.close();
			await deadline(resumedClosed, "resumed RPC close");
		}
		const outputs = { ...files(box.dir, stage), rpc: JSON.stringify([client.events, client.responses]),
			session: readFileSync(state.data.sessionFile, "utf8"), fork: readFileSync(forkState.data.sessionFile, "utf8"),
			stderr: client.stderr + resumed.stderr, state: JSON.stringify([state, forkState, resumedState]),
			resumed: JSON.stringify([resumed.events, resumed.responses]), transcript: JSON.stringify(messages) };
		assert.equal(scan(outputs, sentinel).length, 0, "secret leak in enumerated RPC artifacts");
		rmSync(stage);
		assert.equal(scan(files(box.dir), sentinel).length, 0, "secret leak after staging cleanup");
		// Negative control: deliberately leak each encoded representation into a trace-shaped file.
		const leaky = join(box.dir, "deliberately-leaky-trace.ndjson");
		for (const encoded of variants(sentinel)) {
			writeFileSync(leaky, encoded);
			assert.equal(scan(files(box.dir), sentinel).includes("deliberately-leaky-trace.ndjson"), true);
		}
		rmSync(leaky);
		return { checks: "exact callback; private receipt; real session and fork files; restart; exported transcript; RPC output/stderr; state; every sandbox file; raw/trimmed/partial/JSON/base64/base64url/hex/URI scanner controls",
			artifacts: Object.keys(outputs).length, negativeControls: variants(sentinel).length };
	} finally {
		client.close();
		await deadline(closed, "RPC teardown").catch(() => { client.child.kill("SIGKILL"); });
		box.cleanup();
	}
}

async function tui(outputDir) {
	assert.equal(typeof Bun, "object", "TUI QA runs on Bun's native PTY");
	const box = makeSandbox("secret-tui-qa");
	const stage = join(box.dir, "private-callback");
	const sentinel = randomUUID();
	const cancelledSentinel = randomUUID();
	const listeners = new Set();
	let output = "";
	const wait = (predicate, label) => {
		if (predicate(output)) return Promise.resolve();
		let listener;
		return deadline(new Promise((resolve) => {
			listener = () => { if (predicate(output)) { listeners.delete(listener); resolve(); } };
			listeners.add(listener);
		}), `TUI ${label}`).finally(() => listeners.delete(listener));
	};
	const proc = Bun.spawn([resolveBun().command, cliEntry(), "--no-context-files", "--no-skills", "--no-extensions",
		"--extension", fixture(box), "--approve"], {
		cwd: box.cwd, env: { ...environment(box, stage), TERM: "xterm-256color" },
		terminal: { cols: 100, rows: 30, data(_terminal, bytes) {
			output += Buffer.from(bytes).toString();
			for (const listener of [...listeners]) listener();
		} },
	});
	try {
		await wait((text) => text.includes("SECRET_QA_READY"), "ready");
		await wait((text) => /\bdone\b/.test(text), "startup idle");
		const field = wait((text) => text.includes("SECRET_QA_FIELD"), "field");
		const typed = wait((text) => text.includes("/secret-qa"), "typed command");
		proc.terminal.write("/secret-qa");
		await typed;
		proc.terminal.write("\r");
		await field;
		const masked = wait((text) => text.includes("********"), "masked");
		proc.terminal.write(`\x1b[200~${sentinel}\x1b[201~`);
		await masked;
		const beforeResize = output.length;
		const resized = wait((text) => text.length > beforeResize, "resize");
		proc.terminal.resize(50, 20);
		await resized;
		const consumed = wait((text) => text.includes("SECRET_QA_CONSUMED"), "consumed");
		proc.terminal.write("\r");
		await consumed;
		assert.equal(readFileSync(stage, "utf8") === sentinel, true, "TUI callback exact bytes");
		assert.equal(scan({ output, ...files(box.dir, stage) }, sentinel).length, 0, "terminal/listener leak");
		rmSync(stage);
		const reopenStart = output.length;
		const reopened = wait((text) => text.slice(reopenStart).includes("SECRET_QA_FIELD"), "reopened field");
		const typedAgain = wait((text) => text.slice(reopenStart).includes("/secret-qa"), "second command");
		proc.terminal.write("/secret-qa");
		await typedAgain;
		proc.terminal.write("\r");
		await reopened;
		const cancelStart = output.length;
		const cancelMask = wait((text) => text.slice(cancelStart).includes("********"), "cancelled mask");
		proc.terminal.write(`\x1b[200~${cancelledSentinel}\x1b[201~`);
		await cancelMask;
		const cancelled = wait((text) => text.slice(cancelStart).includes("SECRET_QA_CANCELLED"), "cancelled");
		proc.terminal.write("\x1b");
		await cancelled;
		assert.equal(existsSync(stage), false, "cancelled input did not reach private consumer");
		const quitting = wait((text) => text.includes("/quit"), "quit command");
		proc.terminal.write("/quit");
		await quitting;
		proc.terminal.write("\r");
		await deadline(proc.exited, "TUI close");
		assert.equal(scan({ output, ...files(box.dir) }, sentinel).length, 0, "TUI shutdown leak");
		assert.equal(scan({ output, ...files(box.dir) }, cancelledSentinel).length, 0, "TUI cancellation leak");
		writeFileSync(join(outputDir, "tui-output.ansi"), output);
		return { checks: "native PTY; masked paste; resize 100x30 to 50x20; exact callback; raw listener exclusion; submit/cancel and cleanup", capturedBytes: Buffer.byteLength(output) };
	} finally {
		if ([sentinel, cancelledSentinel].every((value) => scan({ output }, value).length === 0))
			writeFileSync(join(outputDir, "tui-output.ansi"), output);
		if (proc.exitCode === null) proc.kill();
		await deadline(proc.exited, "TUI teardown").catch(() => proc.kill("SIGKILL"));
		proc.terminal?.close();
		box.cleanup();
	}
}

const guard = guardRealAuth();
const directory = evidenceDir("secret-input-5108");
try {
	const rpcResult = await rpc();
	writeFileSync(join(directory, "rpc-result.json"), JSON.stringify({ ...rpcResult, sentinelLeaks: 0 }, null, 2));
	const tuiResult = process.argv.includes("--rpc-only") ? undefined : await tui(directory);
	guard.assertUnchanged();
	writeFileSync(join(directory, "result.json"), JSON.stringify({ rpc: rpcResult, tui: tuiResult, sentinelLeaks: 0,
		scannerNegativeControl: `${rpcResult.negativeControls} variants detected`, authUnchanged: true, cleanup: "sandboxes removed" }, null, 2));
	console.log(`SECRET_INPUT_QA PASS ${directory}`);
} catch (error) {
	// Do not print a request-bearing assertion actual or a transport cause.
	console.error(`SECRET_INPUT_QA FAIL ${error instanceof Error ? error.message.split("\n")[0] : "fixed failure"}`);
	process.exitCode = 1;
}
