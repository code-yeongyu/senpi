import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCH_KEY_FAILED_EXIT_CODE } from "../../src/cli/launch-key.ts";
import { launchHand, launchHeadless, launchInteractive, launchPrint, launchRpc } from "../../src/engine/launch.ts";
import type { LaunchPrintEvent } from "../../src/engine/launch-print-stream.ts";
import type { LaunchPorts } from "../../src/engine/launch-process.ts";
import { CLI, CLI_MAIN, realEngine } from "./real-engine.ts";

const FAKE_ENGINE = join(__dirname, "..", "fixtures", "engine-launch-fake.ts");
const KEY = () => Readable.from([Buffer.from("sk-canary-key-failure-7451")]);

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-launch-key-failure-")));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An engine that refused its key: it exits with the engine's launch-key failure code, as `main()` does. */
function refusingEngine(): LaunchPorts {
	return {
		spawn: (cmd: string, args: readonly string[], options: SpawnOptions): ChildProcess => spawn(cmd, args, options),
		engine: () => ({ command: "bun", args: [FAKE_ENGINE] }),
		env: () => ({ PATH: process.env.PATH ?? "", HOME: root, FAKE_ENGINE_EXIT: String(LAUNCH_KEY_FAILED_EXIT_CODE) }),
		agentDir: () => join(root, "agent"),
	};
}

describe("a launch answers launch_key_failed on every mode (security design 5.5, ruled bound)", () => {
	it("interactive answers the typed error", async () => {
		expect(await launchInteractive(refusingEngine(), { api_key: KEY() })).toMatchObject({
			kind: "error",
			error: { code: "launch_key_failed" },
		});
	});

	it("reads exit 78 as a plain code on a launch that handed no key over", async () => {
		expect(await launchInteractive(refusingEngine(), {})).toMatchObject({
			kind: "ok",
			value: { exit_code: LAUNCH_KEY_FAILED_EXIT_CODE },
		});
	});

	it("print ends its stream with an exit that names the failure", async () => {
		const run = await launchPrint(refusingEngine(), { input: { messages: ["x"] }, mode: "json", api_key: KEY() });
		if (run.kind !== "ok") throw new Error("launch refused");
		const events: LaunchPrintEvent[] = [];
		for await (const event of run.value.events) events.push(event);
		expect(events.at(-1)).toMatchObject({ type: "exit", failure: "launch_key_failed" });
	});

	it.each([
		["rpc", () => launchRpc(refusingEngine(), { api_key: KEY() })],
		["hand", () => launchHand(refusingEngine(), { api_key: KEY() })],
		["headless", () => launchHeadless(refusingEngine(), { api_key: KEY() })],
	])("%s resolves its exit with the failure", async (_mode, launch) => {
		const run = await launch();
		if (run.kind !== "ok") throw new Error("launch refused");
		expect(await run.value.exited).toEqual({ exit_code: LAUNCH_KEY_FAILED_EXIT_CODE, failure: "launch_key_failed" });
	});
});

describe("the real engine entry (review 6064845699 M1, L5)", () => {
	it.each([
		["cli.ts", [], CLI],
		["cli.ts across the hop", ["--smol"], CLI],
		["cli-main", [], CLI_MAIN],
	] as const)(
		"refuses a handed-over key it cannot read at %s when --list-tips sits in an option's value position (review 6068111644 N1)",
		async (_route, runtime, entry) => {
			const file = openSync(join(root, "not-a-channel-n1"), "w");
			try {
				const run = await realEngine(["-p", "--system-prompt", "--list-tips", "hello"], {
					root,
					table: JSON.stringify({ "api-key": 5 }),
					slot5: file,
					runtime,
					entry,
				});
				expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
				expect(run.output).toContain("launch_key_unreadable");
			} finally {
				closeSync(file);
			}
		},
	);

	it("fails closed when the key channel names a descriptor that is not a channel", async () => {
		const file = openSync(join(root, "not-a-channel"), "w");
		try {
			const run = await realEngine(["--print-prompt-sizes"], {
				root,
				table: JSON.stringify({ "api-key": 5 }),
				slot5: file,
			});
			expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
			expect(run.output).toContain("launch_key_unreadable");
		} finally {
			closeSync(file);
		}
	});

	it("fails closed across the entry's isolated-child hop (bun --smol), where only the entry's guard sees the refusal", async () => {
		const file = openSync(join(root, "not-a-channel-hop"), "w");
		try {
			const run = await realEngine(["--print-prompt-sizes"], {
				root,
				table: JSON.stringify({ "api-key": 5 }),
				slot5: file,
				runtime: ["--smol"],
			});
			expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
			expect(run.output).toContain("launch_key_unreadable");
		} finally {
			closeSync(file);
		}
	});

	it("carries a usable key across the isolated-child hop to main(), which refuses it beside --api-key", async () => {
		const run = await realEngine(["--api-key", "x", "--print-prompt-sizes"], {
			root,
			table: JSON.stringify({ "api-key": 5 }),
			write: (sink) => sink.end(Buffer.from("sk-canary-real-hop-7451")),
			runtime: ["--smol"],
		});
		expect(run.code).toBe(1);
		expect(run.output).toContain("--api-key and a launch key cannot be combined");
		expect(run.output).not.toContain("sk-canary-real-hop-7451");
	});

	it("fails closed on a private table that does not parse, since it may have named the key", async () => {
		const run = await realEngine(["--print-prompt-sizes"], { root, table: "garbage" });
		expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
		expect(run.output).toContain("launch_key_unreadable");
	});

	it.each([
		["a table cut short before the key's name", '{"presenter":4,'],
		["a table over the read limit with the key named after the padding", `{"pad":"${"x".repeat(4200)}","api-key":5}`],
	])("refuses a session start on %s (security design B10)", async (_shape, table) => {
		const run = await realEngine(["--print-prompt-sizes"], {
			root,
			table,
			write: (sink) => sink.end(Buffer.from("sk-canary-b10-7451")),
		});
		expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
		expect(run.output).toContain("launch_key_unreadable: the private descriptor table could not be read");
		expect(run.output).not.toContain("sk-canary-b10-7451");
		expect(run.output).not.toContain("presenter");
	});

	const routes: ReadonlyArray<readonly [string, readonly string[], string]> = [
		["cli.ts", [], CLI],
		["cli.ts across the hop", ["--smol"], CLI],
		["cli-main", [], CLI_MAIN],
	];
	it.each(
		routes.flatMap(([route, runtime, entry]) =>
			["-h", "-v", "--help", "--version"].map((token) => [token, route, runtime, entry] as const),
		),
	)(
		"refuses a message %s after -- at %s: only options before -- start no session",
		async (token, _route, runtime, entry) => {
			const run = await realEngine(["--print-prompt-sizes", "--", token], {
				root,
				table: '{"presenter":4,',
				runtime,
				entry,
			});
			expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
			expect(run.output).toContain("the private descriptor table could not be read");
		},
	);

	it("refuses a session start at cli-main handed the supervisor's forwarded unparseable marker", async () => {
		const run = await realEngine(["--print-prompt-sizes"], {
			root,
			table: "unparseable",
			runtime: [],
			entry: CLI_MAIN,
		});
		expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
		expect(run.output).toContain("the private descriptor table could not be read");
	});

	it("starts normally when the key was taken by an earlier hop (declared null)", async () => {
		const run = await realEngine(["--print-prompt-sizes"], { root, table: JSON.stringify({ "api-key": null }) });
		expect(run.code).toBe(0);
		expect(run.output).not.toContain("launch_key_");
	});

	it("carries a key through the entry's own hops to main(), which refuses it beside --api-key", async () => {
		const run = await realEngine(["--api-key", "x", "--print-prompt-sizes"], {
			root,
			table: JSON.stringify({ "api-key": 5 }),
			write: (sink) => sink.end(Buffer.from("sk-canary-real-entry-7451")),
		});
		expect(run.code).toBe(1);
		expect(run.output).toContain("--api-key and a launch key cannot be combined");
		expect(run.output).not.toContain("sk-canary-real-entry-7451");
	});
});

describe("the engine fails closed on a key it refuses", () => {
	it("exits with the launch-key failure code, names the failure, and prints no key bytes", async () => {
		const child = spawn("bun", [CLI, "--print-prompt-sizes"], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"],
			env: {
				PATH: process.env.PATH ?? "",
				HOME: root,
				SENPI_CODING_AGENT_DIR: join(root, "agent"),
				PI_OFFLINE: "1",
				NO_COLOR: "1",
				SENPI_PRIVATE_FDS: JSON.stringify({ "api-key": 5 }),
			},
		});
		const sink: unknown = Reflect.get(child.stdio, 5);
		if (!(sink instanceof Writable)) throw new Error("no key pipe on descriptor 5");
		sink.on("error", () => {});
		sink.end(Buffer.alloc(70 * 1024, "k"));
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += String(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += String(chunk);
		});
		const code = await new Promise<number | null>((done) => child.once("close", done));
		expect(code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
		expect(output).toContain("launch_key_too_large");
		expect(output).not.toContain("kkkkkkkk");
	});
});
