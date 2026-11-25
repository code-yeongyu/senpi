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

const FAKE_ENGINE = join(__dirname, "..", "fixtures", "engine-launch-fake.ts");
const CLI = join(__dirname, "..", "..", "src", "cli.ts");
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

/** Starts the real CLI entry with a private table and descriptor 5 as given, and collects its exit and output. */
async function realEngine(
	args: readonly string[],
	table: string,
	slot5: "pipe" | number,
	write?: (sink: Writable) => void,
): Promise<{ readonly code: number | null; readonly output: string }> {
	const child = spawn("bun", [CLI, ...args], {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", slot5],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			SENPI_CODING_AGENT_DIR: join(root, "agent"),
			PI_OFFLINE: "1",
			NO_COLOR: "1",
			SENPI_PRIVATE_FDS: table,
		},
	});
	const sink: unknown = Reflect.get(child.stdio, 5);
	if (sink instanceof Writable) {
		sink.on("error", () => {});
		write?.(sink);
	}
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => (output += String(chunk)));
	const code = await new Promise<number | null>((done) => child.once("close", done));
	return { code, output };
}

describe("the real engine entry (review 6064845699 M1, L5)", () => {
	it("fails closed when the key channel names a descriptor that is not a channel", async () => {
		const file = openSync(join(root, "not-a-channel"), "w");
		try {
			const run = await realEngine(["--list-tips"], JSON.stringify({ "api-key": 5 }), file);
			expect(run.code).toBe(LAUNCH_KEY_FAILED_EXIT_CODE);
			expect(run.output).toContain("launch_key_unreadable");
		} finally {
			closeSync(file);
		}
	});

	it("starts normally when the key was taken by an earlier hop (declared null)", async () => {
		const run = await realEngine(["--list-tips"], JSON.stringify({ "api-key": null }), "pipe");
		expect(run.code).toBe(0);
		expect(run.output).not.toContain("launch_key_");
	});

	it("carries a key through the entry's own hops to main(), which refuses it beside --api-key", async () => {
		const run = await realEngine(
			["--api-key", "x", "--list-tips"],
			JSON.stringify({ "api-key": 5 }),
			"pipe",
			(sink) => sink.end(Buffer.from("sk-canary-real-entry-7451")),
		);
		expect(run.code).toBe(1);
		expect(run.output).toContain("--api-key and a launch key cannot be combined");
		expect(run.output).not.toContain("sk-canary-real-entry-7451");
	});
});

describe("the engine fails closed on a key it refuses", () => {
	it("exits with the launch-key failure code, names the failure, and prints no key bytes", async () => {
		const child = spawn("bun", [CLI, "--list-tips"], {
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
