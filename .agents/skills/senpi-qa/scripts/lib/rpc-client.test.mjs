import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { childRuntime, cleanupAll, makeSandbox, resolveChildRuntime, spawnCli } from "./common.mjs";
import { startFakeModelServer } from "./fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "./mock-loop-support.mjs";
import { RpcClient } from "./rpc-client.mjs";

const RPC_DRIVE = join(dirname(fileURLToPath(import.meta.url)), "..", "rpc-drive.mjs");
const MOCK = API_PRESETS["openai-completions"];
const MOCK_ARGS = ["--provider", MOCK.provider, "--model", MOCK.modelId, "--no-extensions", "--no-skills"];

test.after(cleanupAll);

async function mockedSandbox(label, reply) {
	const box = makeSandbox(label);
	const server = await startFakeModelServer({ turns: [{ text: reply }] });
	writeMockModelsJson(box.agentDir, server, "openai-completions");
	return { box, server, env: hermeticEnv(box.env) };
}

function exitOf(child) {
	return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "close");
}

test("the tested CLI child runs on Bun by default; Node and a binary only on request", () => {
	const bun = resolveChildRuntime([]);
	assert.equal(bun.kind, "bun");
	const [major, minor] = bun.label.replace(/^bun@/, "").split(".").map(Number);
	assert.ok(major > 1 || (major === 1 && minor >= 4), `Bun child must be >= 1.4, got ${bun.label}`);

	const node = resolveChildRuntime(["--child", "node"]);
	assert.equal(node.kind, "node");
	assert.match(node.label, /^node@\d+\.\d+\.\d+$/);

	const binary = resolveChildRuntime(["--child", `binary:${process.execPath}`]);
	assert.deepEqual(binary, { kind: "binary", command: process.execPath, label: `binary:${process.execPath}` });

	assert.throws(() => resolveChildRuntime(["--child", "deno"]), /--child must be/);
	assert.throws(() => resolveChildRuntime(["--child", "binary:"]), /--child must be/);
	assert.throws(() => resolveChildRuntime(["--child", "binary:/nonexistent/senpi"]), /no file at/);
});

test("RpcClient persists its session under the sandbox session dir", { timeout: 120_000 }, async () => {
	const { box, server, env } = await mockedSandbox("rpc-client-persisted", "SENPI-QA-PERSISTED-5c1e");
	const client = new RpcClient({ env, cwd: box.cwd, extraArgs: MOCK_ARGS });
	try {
		assert.equal(client.child.spawnfile, childRuntime().command, "spawned on the resolved child runtime");
		const state = await client.send({ type: "get_state" });
		assert.equal(state.success, true, JSON.stringify(state));
		const sessionFile = state.data.sessionFile;
		assert.equal(typeof sessionFile, "string", "a persisted session has a session file");
		assert.ok(sessionFile.startsWith(box.sessionDir), `${sessionFile} is under ${box.sessionDir}`);

		const ack = await client.send({ type: "prompt", message: "reply with the marker" });
		assert.equal(ack.success, true, JSON.stringify(ack));
		const end = await client.waitForEvent((e) => e.type === "agent_end" || e.type === "agent_aborted", { timeoutMs: 90_000 });
		assert.equal(end.type, "agent_end");
		client.close();
		await exitOf(client.child);
		assert.match(readFileSync(sessionFile, "utf8"), /SENPI-QA-PERSISTED-5c1e/);
	} finally {
		client.close();
		await server.stop();
		box.cleanup();
	}
});

test("rpc-drive --attach <socket> --state reads get_state from a running host", { timeout: 120_000 }, async () => {
	const { box, server, env } = await mockedSandbox("rpc-client-attach", "SENPI-QA-ATTACH-OK");
	// Unix socket paths are capped near 104 bytes; keep only the socket in a short temp dir.
	const socketDir = mkdtempSync(join(tmpdir(), "rqa-"));
	const socket = join(socketDir, "h.sock");
	const host = spawnCli(
		["--mode", "rpc", "--multi-session", "--listen", socket, "--session-runtime", "in-process", "--no-context-files", ...MOCK_ARGS],
		{ env, cwd: box.cwd },
	);
	try {
		let hostErr = "";
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`host never listened: ${hostErr.slice(-400)}`)), 60_000);
			host.stderr.on("data", (d) => {
				hostErr += d.toString();
				if (hostErr.includes("senpi rpc listening on")) {
					clearTimeout(timer);
					resolve();
				}
			});
			host.once("close", (code) => {
				clearTimeout(timer);
				reject(new Error(`host exited ${code}: ${hostErr.slice(-400)}`));
			});
		});

		const driver = spawn(process.execPath, [RPC_DRIVE, "--attach", socket, "--state"], { env, cwd: box.cwd });
		let stdout = "";
		let stderr = "";
		driver.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		driver.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		const [code] = await once(driver, "close");
		assert.equal(code, 0, `driver failed: ${stderr.slice(-800)}`);
		const res = JSON.parse(stdout);
		assert.equal(res.command, "get_state");
		assert.equal(res.success, true);
		assert.equal(typeof res.data.sessionFile, "string");
		assert.ok(res.data.sessionFile.startsWith(box.dir), `${res.data.sessionFile} stays inside the sandbox ${box.dir}`);
	} finally {
		host.kill("SIGTERM");
		await exitOf(host);
		await server.stop();
		rmSync(socketDir, { recursive: true, force: true });
		box.cleanup();
	}
});
