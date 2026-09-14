import { beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

const repo = resolve(import.meta.dir, "..");
const cli = join(repo, "packages/coding-agent/dist/bundle/cli.js");
const responseSchema = z.object({
	type: z.string(), id: z.string().optional(), success: z.boolean().optional(),
	data: z.unknown().optional(), error: z.unknown().optional(),
});

beforeAll(() => {
	const result = spawnSync("node", ["scripts/build-coding-agent-bundle.mjs"], {
		cwd: repo, encoding: "utf8", timeout: 120_000,
	});
	expect(result.status, result.stderr).toBe(0);
}, 130_000);

test("reports the package version when the Node bundle is launched", () => {
	// Given
	const manifest = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(repo, "packages/coding-agent/package.json"), "utf8")));
	// When
	const result = spawnSync("node", [cli, "--version"], { encoding: "utf8", timeout: 30_000 });
	// Then
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe(manifest.version);
});

test("opens and closes a shared session when the Node bundle receives RPC commands", async () => {
	// Given: isolated state, with no provider request or user extensions.
	const state = mkdtempSync(join(tmpdir(), "senpi-node-bundle-"));
	mkdirSync(join(state, "home"));
	writeFileSync(join(state, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["codemode"] }));
	const child = spawn("node", [cli, "--mode", "rpc", "--multi-session"], {
		cwd: state, stdio: ["pipe", "pipe", "pipe"], env: {
			PATH: process.env.PATH, HOME: join(state, "home"), TMPDIR: state,
			SENPI_CODING_AGENT_DIR: state, PI_OFFLINE: "1",
		},
	});
	const exit = once(child, "exit", { signal: AbortSignal.timeout(90_000) });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000); });
	const lines = createInterface({ input: child.stdout });
	const request = async (command: { readonly type: string; readonly sessionId?: string; readonly cwd?: string }) => {
		const responses = on(lines, "line", { close: ["close"], signal: AbortSignal.timeout(30_000) });
		child.stdin.write(`${JSON.stringify({ id: command.type, ...command })}\n`);
		try {
			for await (const args of responses) {
				const response = responseSchema.parse(JSON.parse(z.string().parse(args[0])));
				if (response.id !== command.type) continue;
				expect(response.success, `${JSON.stringify(response)}\n${stderr}`).toBe(true);
				return response.data;
			}
			throw new Error(`RPC closed before response: ${stderr}`);
		} finally {
			await responses.return();
		}
	};
	try {
		// When: exercise the worker's real prepare/commit/bind/close lifecycle.
		const opened = z.object({ sessionId: z.string() }).parse(await request({ type: "open_session", cwd: state }));
		const snapshot = await request({ type: "get_state", sessionId: opened.sessionId });
		const closed = await request({ type: "close_session", sessionId: opened.sessionId });
		// Then: the worker answered a session command and the host acknowledged close.
		// Physical worker exit is asynchronous after the close response.
		expect(z.object({ isStreaming: z.boolean() }).parse(snapshot).isStreaming).toBe(false);
		expect(closed).toEqual({});
	} finally {
		child.kill("SIGKILL");
		await exit;
		lines.close();
		rmSync(state, { recursive: true, force: true });
	}
}, 100_000);
