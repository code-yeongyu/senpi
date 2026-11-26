/**
 * The security design's non-disclosure test (section 6) over every function slice E1a-s adds: synthetic canaries
 * in fake ports, every outcome (ok, each refusal, one injected fault), every prohibited output scanned, and the
 * one authorized destination (the launched process, for the launch key) asserted.
 */
import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LAUNCH_KEY_FAILED_EXIT_CODE } from "../../src/cli/launch-key.ts";
import { getAgentDir } from "../../src/config.ts";
import { engine } from "../../src/engine/index.ts";
import { launchHand, launchHeadless, launchInteractive, launchPrint, launchRpc } from "../../src/engine/launch.ts";
import type { LaunchPrintEvent } from "../../src/engine/launch-print-stream.ts";
import type { LaunchPorts } from "../../src/engine/launch-process.ts";

const CANARIES = {
	stored_api_key: "sk-canary-nd-stored-7451",
	oauth_access: "oat-canary-nd-access-7451",
	oauth_refresh: "ort-canary-nd-refresh-7451",
	launch_key: "sk-canary-nd-launch-7451",
	socket_secret: "sock-canary-nd-secret-7451",
} as const;
const FAKE_ENGINE = join(__dirname, "..", "fixtures", "engine-launch-fake.ts");
const CLI = join(__dirname, "..", "..", "src", "cli.ts");

let root: string;
const childRecords: Array<{ readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }> = [];
const printed: string[] = [];

function leaked(text: string): string[] {
	return Object.entries(CANARIES)
		.filter(([, canary]) => text.includes(canary))
		.map(([name]) => name);
}

function serialized(value: unknown): string {
	return JSON.stringify(value, (_key, field: unknown) =>
		field instanceof Readable || typeof field === "function" ? "[handle]" : field,
	);
}

function ports(env: NodeJS.ProcessEnv = {}, command = "bun"): LaunchPorts {
	return {
		spawn: (cmd: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
			childRecords.push({ args: [cmd, ...args], env: options.env ?? {} });
			return spawn(cmd, args, options);
		},
		engine: () => ({ command, args: [FAKE_ENGINE] }),
		env: () => ({ PATH: process.env.PATH ?? "", HOME: root, ...env }),
		agentDir: () => join(root, "agent"),
	};
}

async function drained(events: AsyncIterable<LaunchPrintEvent>): Promise<LaunchPrintEvent[]> {
	const all: LaunchPrintEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}

function launchKey(): Readable {
	return Readable.from([Buffer.from(CANARIES.launch_key)]);
}

/**
 * The first models.list over a launch setup binds the built-in extensions and loads their modules once per
 * worker: measured 3.8 s cold against 0.17 s warm in a plain process, and 17.8 s for the case alone under vitest
 * at load 75 (first-use transforms). That one-time setup runs here, where its answer is scanned too, so the case
 * below measures the call itself.
 */
beforeAll(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-nd-")));
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(
		join(getAgentDir(), "auth.json"),
		JSON.stringify({
			openai: { type: "api_key", key: CANARIES.stored_api_key },
			"chatgpt-subscription": {
				type: "oauth",
				access: CANARIES.oauth_access,
				refresh: CANARIES.oauth_refresh,
				expires: Date.now() + 3_600_000,
			},
		}),
		{ mode: 0o600 },
	);
	mkdirSync(join(root, "keys"), { recursive: true });
	writeFileSync(join(root, "keys", "rpc.key"), CANARIES.socket_secret, { mode: 0o600 });
	for (const stream of [process.stdout, process.stderr]) {
		const write = stream.write.bind(stream);
		vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
			printed.push(String(chunk));
			return Reflect.apply(write, stream, [chunk, ...rest]) === true;
		});
	}
	for (const method of ["log", "error", "warn", "info", "debug"] as const) {
		const original = console[method].bind(console);
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			printed.push(args.map(String).join(" "));
			original(...args);
		});
	}
	const warm = await engine.models.list({ setup: { extensions: { none: true } } });
	expect(leaked(serialized(warm))).toEqual([]);
}, 120_000);

afterAll(() => {
	vi.restoreAllMocks();
	rmSync(join(getAgentDir(), "auth.json"), { force: true });
	rmSync(root, { recursive: true, force: true });
});

const OUTCOMES: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
	["auth.check ok", () => engine.auth.check({ provider: "openai", refresh: false })],
	["auth.check oauth ok", () => engine.auth.check({ provider: "chatgpt-subscription", refresh: false })],
	["auth.check refused", () => engine.auth.check({})],
	["auth.credentials refused", () => engine.auth.credentials({ provider: "openai" })],
	["auth.credentials invalid", () => engine.auth.credentials({})],
	["auth.apiKey refused", () => engine.auth.apiKey({ provider: "openai" })],
	["auth.bearerToken refused", () => engine.auth.bearerToken({ provider: "chatgpt-subscription" })],
	["auth.bearerToken invalid", () => engine.auth.bearerToken({ provider: "x", min_expiry_ms: -1 })],
	[
		"host.status with a key root",
		() => engine.host.status({ endpoint: { socket: join(root, "none.sock"), key_root: join(root, "keys") } }),
	],
	["host.stop refused input", () => engine.host.stop({ wait_ms: 5, endpoint: { key_root: join(root, "keys") } })],
	["host.ensure bad presenter", () => engine.host.ensure({ presenter: { bootstrap_fd: 3 } as never })],
	["models.list with setup", () => engine.models.list({ setup: { extensions: { none: true } } })],
	["models.list refused setup", () => engine.models.list({ setup: { session_runtime: "bogus" } as never })],
	["promptSizes refused setup", () => engine.promptSizes({ setup: { tool_runtime: "bogus" } as never })],
	[
		"launch refused, key given",
		() => launchHand(ports(), { api_key: launchKey(), input: { messages: ["x"] } } as never),
	],
	[
		"launch fault: no engine, key given",
		() => launchHeadless(ports({}, join(root, "no-such-engine")), { api_key: launchKey() }),
	],
	["launch.interactive ok, key given", () => launchInteractive(ports(), { api_key: launchKey() })],
];

describe("no canary reaches a prohibited output (security design 6, senpi#7451)", () => {
	it.each(OUTCOMES)("%s", async (_outcome, call) => {
		const before = printed.length;
		const answer = await call();
		expect(leaked(serialized(answer))).toEqual([]);
		expect(leaked(printed.slice(before).join("\n"))).toEqual([]);
	});

	it("a print run, its events and its cancel carry no canary; the key reaches only the launched process", async () => {
		const keyOut = join(root, "key-out");
		const run = await launchPrint(ports({ FAKE_ENGINE_KEY_OUT: keyOut }), {
			input: { messages: ["x"] },
			mode: "json",
			api_key: launchKey(),
		});
		const events = run.kind === "ok" ? await drained(run.value.events) : [];
		expect(leaked(serialized(run))).toEqual([]);
		expect(leaked(serialized(events))).toEqual([]);
		expect(readFileSync(keyOut, "utf8")).toBe(CANARIES.launch_key);

		const held = await launchRpc(ports({ FAKE_ENGINE_HOLD: "1" }), { api_key: launchKey() });
		if (held.kind === "ok") await held.value.stop();
		expect(leaked(serialized(held))).toEqual([]);
	});

	it("no child process started by any outcome carries a canary in its argv or environment", () => {
		expect(childRecords.length).toBeGreaterThan(0);
		expect(leaked(serialized(childRecords))).toEqual([]);
	});

	it("the engine's launch-key failure line carries no canary, and the launch answers the failure", async () => {
		const child = spawn("bun", [CLI, "--print-prompt-sizes"], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"],
			env: {
				PATH: process.env.PATH ?? "",
				HOME: root,
				SENPI_CODING_AGENT_DIR: getAgentDir(),
				PI_OFFLINE: "1",
				NO_COLOR: "1",
				SENPI_PRIVATE_FDS: JSON.stringify({ "api-key": 5 }),
			},
		});
		const sink: unknown = Reflect.get(child.stdio, 5);
		if (!(sink instanceof Writable)) throw new Error("no key pipe on descriptor 5");
		sink.on("error", () => {});
		sink.end(Buffer.from(CANARIES.launch_key.repeat(4096)));
		let output = "";
		for (const stream of [child.stdout, child.stderr])
			stream?.on("data", (chunk: Buffer) => (output += String(chunk)));
		const code = await new Promise<number | null>((done) => child.once("close", done));
		expect(code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
		expect(output).toContain("launch_key_too_large");
		expect(leaked(output)).toEqual([]);
		const refused = await launchInteractive(ports({ FAKE_ENGINE_EXIT: String(LAUNCH_KEY_FAILED_EXIT_CODE) }), {
			api_key: launchKey(),
		});
		expect(refused).toMatchObject({ kind: "error", error: { code: "launch_key_failed" } });
		expect(leaked(serialized(refused))).toEqual([]);
	});

	it("the CLI adapter's output of `auth check --json` carries no canary", () => {
		const result = spawnSync("bun", [CLI, "auth", "check", "--provider", "openai", "--json", "--no-refresh"], {
			cwd: root,
			encoding: "utf8",
			timeout: 120_000,
			env: { PATH: process.env.PATH ?? "", HOME: root, SENPI_CODING_AGENT_DIR: getAgentDir(), PI_OFFLINE: "1" },
		});
		expect(leaked(result.stdout + result.stderr)).toEqual([]);
	});
});
