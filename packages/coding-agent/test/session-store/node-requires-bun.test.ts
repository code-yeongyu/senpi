/**
 * K9.a (senpi#5822): a CLI process still on Node after the Bun re-exec attempt gets one steering message where it would
 * open session state, exits non-zero and creates nothing; the Node-only developer hatch (SENPI_SESSION_STORE=jsonl)
 * keeps the legacy JSONL store. Runs under Node: the children are real CLI processes, one per stay reason.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StayReason } from "../../src/bun-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { NODE_REQUIRES_BUN_MESSAGE } from "../../src/core/session-store/node-guard.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { sourceRuntimeArgs } from "../helpers/source-runtime-args.ts";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const roots: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function realBun(): string | undefined {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(directory, process.platform === "win32" ? "bun.exe" : "bun");
		if (directory !== "" && existsSync(candidate)) return realpathSync(candidate);
	}
	return undefined;
}

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-node-requires-bun-")));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sessions = join(root, "sessions");
	mkdirSync(agentDir);
	writeRpcModelsJson(agentDir, "http://127.0.0.1:1");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
	// An installed-package entry: the stay reasons that need one ("bun-not-found", "bun-too-old") and the re-exec run
	// start the CLI from a script under node_modules, which imports the source CLI.
	const installed = join(root, "node_modules", "senpi", "cli.mjs");
	mkdirSync(dirname(installed), { recursive: true });
	writeFileSync(installed, `import ${JSON.stringify(pathToFileURL(cli).href)};\n`);
	return { root, agentDir, sessions, installed };
}

type Dirs = ReturnType<typeof setup>;

interface Run {
	readonly entry: string;
	readonly env: Record<string, string>;
}

/** The inputs that make the re-exec decision stay on Node for one reason. */
function stayOnNode(dirs: Dirs, reason: Exclude<StayReason, "already-bun">): Run {
	const nodeOnlyPath = dirname(process.execPath);
	switch (reason) {
		case "runtime-pinned-node":
			return { entry: dirs.installed, env: { SENPI_RUNTIME: "node" } };
		case "inspector":
			return { entry: dirs.installed, env: { NODE_OPTIONS: "--inspect-port=0" } };
		case "not-bun-install":
			return { entry: cli, env: {} };
		case "bun-not-found":
			return { entry: dirs.installed, env: { BUN_INSTALL: join(dirs.root, "no-bun"), PATH: nodeOnlyPath } };
		case "bun-too-old": {
			const bin = join(dirs.root, "old-bun", "bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(join(bin, "bun"), "#!/bin/sh\necho 1.3.0\n");
			chmodSync(join(bin, "bun"), 0o755);
			return { entry: dirs.installed, env: { BUN_INSTALL: join(dirs.root, "old-bun"), PATH: nodeOnlyPath } };
		}
	}
}

async function runCli(dirs: Dirs, run: Run, args: readonly string[], requestState: boolean) {
	const child = spawn(process.execPath, [...sourceRuntimeArgs(), run.entry, ...args], {
		cwd: dirs.root,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dirs.root,
			USERPROFILE: dirs.root,
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			SENPI_CODING_AGENT_DIR: dirs.agentDir,
			SENPI_CODING_AGENT_SESSION_DIR: dirs.sessions,
			PI_OFFLINE: "1",
			PI_SKIP_RUNTIME_NOTICE: "1",
			...run.env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	let stdout = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exited = once(child, "close");
	const lines = createInterface({ input: child.stdout });
	const state = new Promise<Record<string, unknown> | undefined>((resolve) => {
		lines.on("line", (line) => {
			stdout += `${line}\n`;
			try {
				const record = JSON.parse(line) as Record<string, unknown>;
				if (record.type === "response" && record.id === "state") resolve(record);
			} catch {}
		});
		child.once("close", () => resolve(undefined));
	});
	if (requestState) child.stdin.write('{"id":"state","type":"get_state"}\n');
	const answered = requestState ? await state : undefined;
	child.stdin.end();
	if (answered !== undefined && child.exitCode === null) child.kill("SIGTERM");
	const [code] = await exited;
	lines.close();
	return { state: answered, stderr, stdout, code: code as number | null };
}

const SESSION_ARGS = [
	"--mode",
	"rpc",
	"--offline",
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-themes",
	"--provider",
	MOCK_PROVIDER,
	"--model",
	MOCK_MODEL,
];

const created = (dirs: Dirs) => ({
	sessionFiles: existsSync(dirs.sessions) ? readdirSync(dirs.sessions, { recursive: true }).length : 0,
	store: existsSync(join(dirs.agentDir, "session-store")),
});

const REASONS = ["runtime-pinned-node", "inspector", "not-bun-install", "bun-not-found", "bun-too-old"] as const;

describe.skipIf(process.versions.bun !== undefined)("a CLI process on Node (K9.a)", { timeout: 60_000 }, () => {
	describe.each(REASONS)("stays on Node: %s", (reason) => {
		it.skipIf(reason === "bun-too-old" && process.platform === "win32")(
			"prints the steering message, exits non-zero and creates no session state",
			async () => {
				const dirs = setup();
				const result = await runCli(dirs, stayOnNode(dirs, reason), SESSION_ARGS, false);
				expect(result.stderr).toContain(NODE_REQUIRES_BUN_MESSAGE);
				expect(result.code).not.toBe(0);
				expect(created(dirs)).toEqual({ sessionFiles: 0, store: false });
			},
		);

		it.skipIf(reason === "bun-too-old" && process.platform === "win32")(
			"opens the session on the legacy JSONL store with no message under the hatch",
			async () => {
				const dirs = setup();
				const run = stayOnNode(dirs, reason);
				const result = await runCli(
					dirs,
					{ ...run, env: { ...run.env, SENPI_SESSION_STORE: "jsonl" } },
					SESSION_ARGS,
					true,
				);
				expect(result.state?.success).toBe(true);
				expect(result.stderr).not.toContain(NODE_REQUIRES_BUN_MESSAGE);
				expect(created(dirs).store).toBe(false);
			},
		);
	});

	it.each([["--version"], ["--help"]])("%s still works on Node", async (flag) => {
		const dirs = setup();
		const result = await runCli(dirs, stayOnNode(dirs, "not-bun-install"), [flag], false);
		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain(NODE_REQUIRES_BUN_MESSAGE);
	});

	it("--no-session still opens on Node", async () => {
		const dirs = setup();
		const result = await runCli(dirs, stayOnNode(dirs, "not-bun-install"), [...SESSION_ARGS, "--no-session"], true);
		expect(result.state?.success).toBe(true);
		expect(result.stderr).not.toContain(NODE_REQUIRES_BUN_MESSAGE);
		expect(created(dirs)).toEqual({ sessionFiles: 0, store: false });
	});

	const bun = realBun();
	it.skipIf(bun === undefined || process.platform === "win32")(
		"an installed CLI with Bun >= 1.4 re-execs under Bun silently and opens the durable store",
		async () => {
			const dirs = setup();
			const bin = join(dirs.root, "bun-install", "bin");
			mkdirSync(bin, { recursive: true });
			symlinkSync(bun ?? "", join(bin, "bun"));
			const result = await runCli(
				dirs,
				{ entry: dirs.installed, env: { BUN_INSTALL: join(dirs.root, "bun-install") } },
				SESSION_ARGS,
				true,
			);
			expect(result.state?.success).toBe(true);
			expect(result.stderr).not.toContain(NODE_REQUIRES_BUN_MESSAGE);
		},
	);
});

describe.skipIf(process.versions.bun !== undefined)("the SDK default-store open on Node (K9.a)", () => {
	const create = (root: string) =>
		createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.create(root, join(root, "sessions")),
			noTools: "all",
		});

	it("throws the steering message for a persisted session", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-sdk-node-")));
		roots.push(root);
		await expect(create(root)).rejects.toThrow(NODE_REQUIRES_BUN_MESSAGE);
		expect(existsSync(join(root, "agent", "session-store"))).toBe(false);
	});

	it("opens the legacy JSONL store under the hatch", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-sdk-node-")));
		roots.push(root);
		vi.stubEnv("SENPI_SESSION_STORE", "jsonl");
		const created = await create(root);
		created.session.dispose();
		expect(existsSync(join(root, "agent", "session-store"))).toBe(false);
	});
});
