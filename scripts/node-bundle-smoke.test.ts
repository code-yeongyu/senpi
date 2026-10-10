import { beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const repo = resolve(import.meta.dir, "..");
const cli = join(repo, "packages/coding-agent/dist/bundle/cli.js");
const version = z
	.object({ version: z.string() })
	.parse(JSON.parse(readFileSync(join(repo, "packages/coding-agent/package.json"), "utf8"))).version;
// `bin.pi` ships this one file, and whichever runtime installed the package executes it: npm
// installs run it on Node through its shebang, `bun install -g` runs the same file on Bun.
const runtimes = ["node", "bun"] as const;
const responseSchema = z.object({
	type: z.string(), id: z.string().optional(), success: z.boolean().optional(),
	data: z.unknown().optional(), error: z.unknown().optional(),
});
// An external extension: TypeScript the bundle must compile at load time, with a type-only
// import of a package that is not installed beside it.
const extensionSource = `import type { ExtensionAPI } from "@code-yeongyu/senpi";
import type { SelectItem } from "@earendil-works/pi-tui";

const flag: SelectItem = { value: "bundle-smoke", label: "Registered by an external TypeScript extension" };

export default function bundleSmokeExtension(pi: ExtensionAPI): void {
	pi.registerFlag(flag.value, { description: flag.label, type: "boolean", default: false });
}
`;

/** Isolated agent state: no inherited config, no provider request, no user extensions. */
function createState(): string {
	const state = mkdtempSync(join(tmpdir(), "senpi-bundle-smoke-"));
	mkdirSync(join(state, "home"));
	writeFileSync(join(state, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["codemode"] }));
	return state;
}

function hermeticEnv(state: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "", HOME: join(state, "home"), TMPDIR: state,
		SENPI_CODING_AGENT_DIR: state, PI_OFFLINE: "1",
	};
}

beforeAll(() => {
	const result = spawnSync("node", ["scripts/build-coding-agent-bundle.mjs"], {
		cwd: repo, encoding: "utf8", timeout: 120_000,
	});
	expect(result.status, result.stderr).toBe(0);
}, 130_000);

test("loads the embedded JavaScript grammar from an isolated Node bundle", () => {
	const state = mkdtempSync(join(tmpdir(), "senpi-node-bundle-grammar-"));
	try {
		const bundle = join(state, "bundle");
		cpSync(join(repo, "packages/coding-agent/dist/bundle"), bundle, { recursive: true });
		const engineChunk = readdirSync(join(bundle, "chunks")).find(
			(path) => path.startsWith("engine-") && path.endsWith(".js"),
		);
		expect(engineChunk).toBeDefined();
		const probe = [
			`const engine = await import(${JSON.stringify(pathToFileURL(join(bundle, "chunks", engineChunk!)).href)});`,
			'const folder = await engine.loadTreeSitterFolder("js", { cache: false, fallback: { id: "heuristic", version: "1", fold: () => ({ status: "raw" }) } });',
			'console.log(folder?.id ?? "undefined");',
		].join(" ");
		for (const runtime of runtimes) {
			const result = spawnSync(runtime, ["--input-type=module", "-e", probe], {
				cwd: state,
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "" },
			});
			expect(result.status, `${runtime}: ${result.stderr}`).toBe(0);
			expect(result.stdout.trim(), runtime).toBe("tree-sitter-wasm");
		}
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
});

// A downstream installer (oh-my-openagent) rewrites these declarations byte-for-byte inside the
// installed bundle, so emitting must keep one literal `claudeCodeVersion="X.Y.Z"` per emitting file.
test("keeps the claudeCodeVersion declarations a downstream installer rewrites", () => {
	// Given
	const bundle = join(repo, "packages/coding-agent/dist/bundle");
	// When
	const declaringFiles = readdirSync(bundle, { recursive: true })
		.map(String)
		.filter((path) => path.endsWith(".js"))
		.flatMap((path) =>
			Array.from(readFileSync(join(bundle, path), "utf8").matchAll(/claudeCodeVersion="\d+\.\d+\.\d+"/g), () => basename(path)),
		)
		.sort();
	// Then
	expect(declaringFiles).toEqual([expect.stringMatching(/^anthropic-messages-.+\.js$/), "session-worker.js"]);
});

describe.each(runtimes)("the Node bundle under %s", (runtime) => {
	test("reports the package version when the bundle is launched", () => {
		// Given / When
		const result = spawnSync(runtime, [cli, "--version"], { encoding: "utf8", timeout: 30_000 });
		// Then
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(version);
	});

	// Custom exec arguments (a profiler or inspector flag, anything in NODE_OPTIONS) are applied at
	// process start, so the entry replays them onto a fresh process. The unbundled entry respawns its
	// sibling `cli-main`; the bundle inlined that module and has no such file, so the respawn has to
	// target the bundle itself.
	test("runs under custom exec arguments instead of looking for an inlined sibling", () => {
		// Given
		const state = createState();
		try {
			// When
			const result = spawnSync(runtime, ["--cpu-prof", "--cpu-prof-dir", state, cli, "--model", "nope/nope", "-p", "hi"], {
				encoding: "utf8", env: hermeticEnv(state), timeout: 60_000,
			});
			// Then: the agent ran and rejected the model, rather than the entry failing to resolve itself.
			const output = `${result.stdout}${result.stderr}`;
			expect(output, output).not.toContain("Module not found");
			expect(output, output).toContain("nope/nope");
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	}, 70_000);

	test("prints help and exits successfully", () => {
		// Given
		const state = createState();
		try {
			// When
			const result = spawnSync(runtime, [cli, "--help"], { encoding: "utf8", env: hermeticEnv(state), timeout: 30_000 });
			// Then
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.length).toBeGreaterThan(0);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("loads an external TypeScript extension and lists the flag it registers", () => {
		// Given: a fresh agent dir, so the help fast path misses its per-extension-set cache and
		// the bundle really compiles and runs the extension.
		const state = createState();
		const extensionDir = mkdtempSync(join(tmpdir(), "senpi-bundle-extension-"));
		const extension = join(extensionDir, "extension.ts");
		writeFileSync(extension, extensionSource);
		try {
			// When
			const result = spawnSync(runtime, [cli, "--extension", extension, "--help"], {
				encoding: "utf8", env: hermeticEnv(state), timeout: 60_000,
			});
			// Then
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("--bundle-smoke");
		} finally {
			rmSync(extensionDir, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("opens and closes a shared session when the bundle receives RPC commands", async () => {
		// Given: isolated state, with no provider request or user extensions.
		const state = createState();
		const child = spawn(runtime, [cli, "--mode", "rpc", "--multi-session"], {
			cwd: state, stdio: ["pipe", "pipe", "pipe"], env: hermeticEnv(state),
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

	test("contributes the bundled gpt-image-gen skill when launched outside the bundle (#2028)", async () => {
		// Given: a dummy OpenAI key turns image generation on, and the cwd is unrelated to the bundle,
		// so an embedded asset path that is resolved against cwd cannot exist.
		const state = createState();
		const child = spawn(runtime, [cli, "--mode", "rpc"], {
			cwd: state, stdio: ["pipe", "pipe", "pipe"], env: { ...hermeticEnv(state), OPENAI_API_KEY: "sk-bundle-smoke-dummy" },
		});
		const exit = once(child, "exit", { signal: AbortSignal.timeout(90_000) });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000); });
		const lines = createInterface({ input: child.stdout });
		const commandsSchema = z.object({
			commands: z.array(z.object({ name: z.string(), sourceInfo: z.object({ path: z.string() }) })),
		});
		try {
			// When
			const responses = on(lines, "line", { close: ["close"], signal: AbortSignal.timeout(60_000) });
			child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
			let commands: z.infer<typeof commandsSchema>["commands"] | undefined;
			for await (const args of responses) {
				const response = responseSchema.parse(JSON.parse(z.string().parse(args[0])));
				if (response.id !== "commands") continue;
				expect(response.success, `${JSON.stringify(response)}\n${stderr}`).toBe(true);
				commands = commandsSchema.parse(response.data).commands;
				break;
			}
			// Then: the skill ships as a real file and the missing-skill notice never fires.
			const skill = commands?.find((command) => command.name === "skill:gpt-image-gen");
			expect(skill, `commands: ${JSON.stringify(commands?.map((command) => command.name))}\n${stderr}`).toBeDefined();
			expect(existsSync(skill?.sourceInfo.path ?? ""), skill?.sourceInfo.path).toBe(true);
			expect(stderr).not.toContain("bundled skill not found");
		} finally {
			child.kill("SIGKILL");
			await exit;
			lines.close();
			rmSync(state, { recursive: true, force: true });
		}
	}, 100_000);

	test("loads every lazily imported provider login flow from the bundle (#1810)", async () => {
		// Given: the bundle resolves each OAuth flow through a computed relative import, so the file
		// must exist beside the chunk that imports it; a missing one surfaces as "Cannot find module".
		const state = createState();
		const child = spawn(runtime, [cli, "--mode", "rpc"], {
			cwd: state, stdio: ["pipe", "pipe", "pipe"], env: hermeticEnv(state),
		});
		const exit = once(child, "exit", { signal: AbortSignal.timeout(90_000) });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000); });
		const lines = createInterface({ input: child.stdout });
		const loginEnd = z.object({ type: z.literal("auth_login_end"), provider: z.string(), error: z.string().optional() });
		const startThenCancel = async (provider: string): Promise<string | undefined> => {
			const events = on(lines, "line", { close: ["close"], signal: AbortSignal.timeout(30_000) });
			child.stdin.write(`${JSON.stringify({ id: `start-${provider}`, type: "login_start", provider })}\n`);
			child.stdin.write(`${JSON.stringify({ id: `cancel-${provider}`, type: "login_cancel", provider })}\n`);
			try {
				for await (const args of events) {
					const parsed = loginEnd.safeParse(JSON.parse(z.string().parse(args[0])));
					if (parsed.success && parsed.data.provider === provider) return parsed.data.error;
				}
				throw new Error(`RPC closed before auth_login_end for ${provider}: ${stderr}`);
			} finally {
				await events.return();
			}
		};
		try {
			// When: start and immediately cancel a login for every provider whose flow is a sibling file.
			for (const provider of ["devin", "cursor", "anthropic", "github-copilot", "openrouter", "xai"]) {
				const error = await startThenCancel(provider);
				// Then: the flow module loaded; the only acceptable failure is our own cancel.
				expect(error ?? "", `${provider}: ${error}\n${stderr}`).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
			}
		} finally {
			child.kill("SIGKILL");
			await exit;
			lines.close();
			rmSync(state, { recursive: true, force: true });
		}
	}, 120_000);
});
