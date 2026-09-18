import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

const repo = resolve(import.meta.dir, "..");
const responseSchema = z.object({
	type: z.string(), id: z.string().optional(), success: z.boolean().optional(),
	data: z.unknown().optional(), message: z.unknown().optional(), error: z.unknown().optional(),
});

test("relocated Node session worker resolves Devin OAuth and API lazy modules", async () => {
	const build = spawnSync("node", ["scripts/build-coding-agent-bundle.mjs"], {
		cwd: repo, encoding: "utf8", timeout: 120_000,
	});
	expect(build.status, build.stderr).toBe(0);
	const root = mkdtempSync(join(repo, "local-ignore/devin-node-bundle-"));
	const pkg = join(root, "relocated # % package");
	const state = join(root, "state");
	mkdirSync(state, { recursive: true });
	mkdirSync(join(root, "home"));
	cpSync(join(repo, "packages/coding-agent/dist/bundle"), join(pkg, "dist/bundle"), { recursive: true });
	cpSync(join(repo, "packages/coding-agent/package.json"), join(pkg, "package.json"));
	cpSync(join(repo, "packages/coding-agent/dist/modes/interactive/theme"), join(pkg, "dist/modes/interactive/theme"), { recursive: true });
	writeFileSync(join(state, "settings.json"), JSON.stringify({
		disabledBuiltinExtensions: ["codemode"], retry: { enabled: false },
	}));
	writeFileSync(join(state, "auth.json"), JSON.stringify({
		devin: { type: "oauth", access: "devin-session-token$bundle-test", refresh: "", expires: 8640000000000000 },
	}));
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		request.resume();
		response.writeHead(400, { "Content-Type": "text/plain" });
		response.end("devin-bundle-regression-sentinel");
	});
	const listening = once(server, "listening", { signal: AbortSignal.timeout(10_000) });
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing local Devin endpoint");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	writeFileSync(join(state, "models.json"), JSON.stringify({ providers: { devin: { baseUrl } } }));
	const preload = join(root, "offline.mjs");
	writeFileSync(preload, `const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== ${JSON.stringify(baseUrl)}) throw new Error("External network disabled in bundle regression");
  return original(input, init);
};\n`);
	const child = spawn("node", ["--import", preload, join(pkg, "dist/bundle/rpc-entry.js"), "--multi-session"], {
		cwd: state, stdio: ["pipe", "pipe", "pipe"],
		env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), TMPDIR: root, SENPI_CODING_AGENT_DIR: state, PI_OFFLINE: "1" },
	});
	const exit = once(child, "exit", { signal: AbortSignal.timeout(90_000) });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000); });
	const lines = createInterface({ input: child.stdout });
	const responses = on(lines, "line", { close: ["close"], signal: AbortSignal.timeout(60_000) });
	const next = async (predicate: (response: z.infer<typeof responseSchema>) => boolean) => {
		while (true) {
			const { value, done } = await responses.next();
			if (done) throw new Error(`RPC closed before expected event: ${stderr}`);
			const response = responseSchema.parse(JSON.parse(z.string().parse(value[0])));
			if (predicate(response)) return response;
		}
	};
	const send = (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`);
	try {
		send({ id: "open", type: "open_session", cwd: state, provider: "devin", modelId: "swe-1-6", auto_title: false });
		const opened = await next((response) => response.id === "open");
		expect(opened.success, `${JSON.stringify(opened)}\n${stderr}`).toBe(true);
		const { sessionId } = z.object({ sessionId: z.string() }).parse(opened.data);
		send({ id: "prompt", type: "prompt", sessionId, message: "Exercise the bundled Devin provider" });
		const terminal = await next((response) =>
			(response.type === "message_end" && z.object({ role: z.string() }).parse(response.message).role === "assistant") ||
			(response.id === "prompt" && response.success === false));
		expect(terminal.success, JSON.stringify(terminal)).not.toBe(false);
		const message = z.object({ role: z.literal("assistant"), stopReason: z.literal("error"), errorMessage: z.string() }).parse(terminal.message);
		expect(message.errorMessage).toContain("devin-bundle-regression-sentinel");
		expect(requests).toEqual(["/exa.auth_pb.AuthService/GetUserJwt"]);
		send({ id: "close", type: "close_session", sessionId });
		const closed = await next((response) => response.id === "close");
		expect(closed.success, JSON.stringify(closed)).toBe(true);
	} finally {
		await responses.return?.();
		child.kill("SIGKILL");
		await exit;
		lines.close();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}, 220_000);
