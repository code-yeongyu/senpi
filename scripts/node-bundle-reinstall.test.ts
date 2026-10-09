import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

// #2358: `bun install -g` / `npm i -g` delete and rewrite the package directory under a running
// session. The session must keep running the build it started with, including every chunk it has
// not imported yet.
const repo = resolve(import.meta.dir, "..");
const builtPackage = join(repo, "packages/coding-agent");
const runtimes = ["node", "bun"] as const;
const REINSTALLED_CHUNK = "openai-completions-REINSTALLED.js";
const eventSchema = z.object({ type: z.string(), id: z.string().optional(), success: z.boolean().optional() }).passthrough();
const assistantSchema = z.object({
	role: z.literal("assistant"),
	stopReason: z.string(),
	errorMessage: z.string().optional(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
});

function createInstallRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-reinstall-"));
	const modules = join(root, "node_modules");
	mkdirSync(join(modules, "@code-yeongyu"), { recursive: true });
	for (const entry of readdirSync(join(repo, "node_modules"))) {
		if (entry === "@code-yeongyu" || entry === ".bin") continue;
		symlinkSync(join(repo, "node_modules", entry), join(modules, entry));
	}
	for (const entry of readdirSync(join(repo, "node_modules/@code-yeongyu"))) {
		if (entry !== "senpi") symlinkSync(join(repo, "node_modules/@code-yeongyu", entry), join(modules, "@code-yeongyu", entry));
	}
	return root;
}

/**
 * Replaces the package the way a package manager does: delete the directory, extract a build.
 * The second build renames the lazily imported OpenAI completions chunk, as a new release would.
 */
function installBuild(root: string, build: "first" | "second"): string {
	const target = join(root, "node_modules/@code-yeongyu/senpi");
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	cpSync(join(builtPackage, "package.json"), join(target, "package.json"));
	cpSync(join(builtPackage, "dist"), join(target, "dist"), { recursive: true });
	if (existsSync(join(builtPackage, "node_modules"))) {
		symlinkSync(join(builtPackage, "node_modules"), join(target, "node_modules"));
	}
	if (build === "second") {
		const bundle = join(target, "dist/bundle");
		const chunks = join(bundle, "chunks");
		const original = readdirSync(chunks).find((name) => /^openai-completions-[A-Z0-9]+\.js$/.test(name));
		if (!original) throw new Error("the bundle has no lazily imported openai-completions chunk");
		renameSync(join(chunks, original), join(chunks, REINSTALLED_CHUNK));
		for (const file of readdirSync(bundle, { recursive: true }).map(String)) {
			if (!file.endsWith(".js") && file !== "runtime-manifest.json") continue;
			const path = join(bundle, file);
			const text = readFileSync(path, "utf8");
			const rewritten = text.replaceAll(original, REINSTALLED_CHUNK).replace(/"buildId":"([^"]+)"/, '"buildId":"$1-second"');
			if (rewritten !== text) writeFileSync(path, rewritten);
		}
	}
	return join(target, "dist/bundle/cli.js");
}

function startCompletionsServer(): ReturnType<typeof Bun.serve> {
	const chunk = (body: object) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...body })}\n\n`;
	return Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			new Response(
				chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] }) +
					chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			),
	});
}

function createState(baseUrl: string): string {
	const state = mkdtempSync(join(tmpdir(), "senpi-reinstall-state-"));
	mkdirSync(join(state, "home"));
	writeFileSync(join(state, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["codemode"] }));
	writeFileSync(
		join(state, "models.json"),
		JSON.stringify({ providers: { mock: { baseUrl, api: "openai-completions", apiKey: "dummy", models: [{ id: "m" }] } } }),
	);
	return state;
}

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	const result = spawnSync("node", ["scripts/build-coding-agent-bundle.mjs"], { cwd: repo, encoding: "utf8", timeout: 120_000 });
	expect(result.status, result.stderr).toBe(0);
	server = startCompletionsServer();
}, 130_000);

afterAll(() => {
	server?.stop(true);
});

describe.each(runtimes)("a running bundle under %s", (runtime) => {
	test("keeps answering after the package is reinstalled with a different build (#2358)", async () => {
		// Given: a session running from the first build, then the package replaced by a second build
		// whose lazily imported provider chunk has a new name.
		const root = createInstallRoot();
		const state = createState(`http://127.0.0.1:${server.port}/v1`);
		const cli = installBuild(root, "first");
		const child = spawn(runtime, [cli, "--mode", "rpc", "--model", "mock/m"], {
			cwd: state,
			stdio: ["pipe", "pipe", "pipe"],
			env: { PATH: process.env.PATH ?? "", HOME: join(state, "home"), TMPDIR: state, SENPI_CODING_AGENT_DIR: state, PI_OFFLINE: "1" },
		});
		const exit = once(child, "exit", { signal: AbortSignal.timeout(150_000) });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-16000);
		});
		const lines = createInterface({ input: child.stdout });
		const next = async (matches: (event: z.infer<typeof eventSchema>) => boolean) => {
			for await (const args of on(lines, "line", { close: ["close"], signal: AbortSignal.timeout(60_000) })) {
				const event = eventSchema.safeParse(JSON.parse(z.string().parse(args[0])));
				if (event.success && matches(event.data)) return event.data;
			}
			throw new Error(`RPC closed early: ${stderr}`);
		};
		try {
			const ready = next((event) => event.id === "ready");
			child.stdin.write(`${JSON.stringify({ id: "ready", type: "get_state" })}\n`);
			expect((await ready).success, stderr).toBe(true);
			installBuild(root, "second");

			// When: the next prompt needs the provider chunk this process has not imported yet.
			const answered = next((event) => event.type === "message_end" && assistantSchema.safeParse(event.message).success);
			child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "ping" })}\n`);
			const message = assistantSchema.parse((await answered).message);

			// Then: the reply arrives instead of "Cannot find module './openai-completions-<hash>.js'".
			expect(message.errorMessage ?? "", stderr).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND|ENOENT reading/);
			expect(message.stopReason, message.errorMessage).toBe("stop");
			expect(message.content.map((part) => part.text ?? "").join("")).toBe("pong");
		} finally {
			child.kill("SIGKILL");
			await exit;
			lines.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	}, 160_000);
});
