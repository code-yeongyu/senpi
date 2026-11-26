import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchHand, launchHeadless, launchInteractive, launchPrint, launchRpc } from "../../src/engine/launch.ts";
import { type LaunchPrintEvent, type LaunchPrintRun, printRun } from "../../src/engine/launch-print-stream.ts";
import type { LaunchPorts } from "../../src/engine/launch-process.ts";

const FAKE_ENGINE = join(__dirname, "..", "fixtures", "engine-launch-fake.ts");
const CANARY = "sk-canary-e1as-launch-7451";

interface SpawnRecord {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

let root: string;
let spawned: SpawnRecord[];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-launch-")));
	spawned = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function ports(env: NodeJS.ProcessEnv = {}, command = "bun"): LaunchPorts {
	return {
		spawn: (cmd: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
			spawned.push({ command: cmd, args, env: options.env ?? {} });
			return spawn(cmd, args, options);
		},
		engine: () => ({ command, args: [FAKE_ENGINE] }),
		env: () => ({ PATH: process.env.PATH ?? "", HOME: root, ...env }),
		agentDir: () => join(root, "agent"),
	};
}

async function drain(run: LaunchPrintRun): Promise<LaunchPrintEvent[]> {
	const events: LaunchPrintEvent[] = [];
	for await (const event of run.events) events.push(event);
	return events;
}

function terminal(events: readonly LaunchPrintEvent[]): LaunchPrintEvent | undefined {
	return events.at(-1);
}

describe("engine.launch.print (senpi#7451)", () => {
	it("streams a json run and names the session from its header when the caller named none", async () => {
		const run = await launchPrint(ports({ FAKE_ENGINE_SESSION: "hdr-1" }), {
			input: { messages: ["hi"] },
			mode: "json",
		});
		expect(run.kind).toBe("ok");
		const events = run.kind === "ok" ? await drain(run.value) : [];
		expect(events[0]).toEqual({ type: "event", event: { type: "session", id: "hdr-1" } });
		expect(terminal(events)).toEqual({ type: "exit", exit_code: 0, session: "hdr-1" });
		expect(spawned[0]?.args).toEqual([FAKE_ENGINE, "--print", "--mode", "json", "--", "hi"]);
	});

	it("answers the session the caller named, over the header", async () => {
		const run = await launchPrint(ports({ FAKE_ENGINE_SESSION: "hdr-1" }), {
			session: { id: "named-1" },
			input: { messages: ["hi"] },
			mode: "json",
		});
		const events = run.kind === "ok" ? await drain(run.value) : [];
		expect(terminal(events)).toEqual({ type: "exit", exit_code: 0, session: "named-1" });
	});

	it("answers no session for a text run with no selector", async () => {
		const run = await launchPrint(ports({ FAKE_ENGINE_SESSION: "hdr-1", FAKE_ENGINE_EXIT: "2" }), {
			input: { messages: ["hi"] },
			mode: "text",
		});
		const events = run.kind === "ok" ? await drain(run.value) : [];
		expect(terminal(events)).toEqual({ type: "exit", exit_code: 2 });
		expect(events.filter((event) => event.type === "output").length).toBeGreaterThan(0);
	});

	it("answers no session for an ephemeral run, even with a header", async () => {
		const run = await launchPrint(ports({ FAKE_ENGINE_SESSION: "hdr-1" }), {
			session: { ephemeral: true },
			input: { messages: ["hi"] },
			mode: "json",
		});
		const events = run.kind === "ok" ? await drain(run.value) : [];
		expect(terminal(events)).toEqual({ type: "exit", exit_code: 0 });
	});

	it("ends with cancelled when stopped", async () => {
		const run = await launchPrint(ports({ FAKE_ENGINE_HOLD: "1" }), { input: { messages: ["hi"] }, mode: "json" });
		if (run.kind !== "ok") throw new Error("launch refused");
		const events: LaunchPrintEvent[] = [];
		for await (const event of run.value.events) {
			events.push(event);
			if (event.type === "event") run.value.stop();
		}
		expect(terminal(events)).toEqual({ type: "cancelled" });
	});
});

describe("text output keeps a character split between two reads (review 7184403047 M3)", () => {
	it("reconstructs the exact text when a UTF-8 sequence arrives in two chunks", async () => {
		const bytes = Buffer.from("가한나", "utf8");
		const split = bytes.indexOf(Buffer.from("한", "utf8")) + 1;
		const stdout = Readable.from([bytes.subarray(0, split), bytes.subarray(split)]);
		const run = printRun({ stdout, kill: () => true } as never, Promise.resolve({ exit_code: 0 }), {
			json: false,
			ephemeral: false,
		});
		const text = (await drain(run)).flatMap((event) => (event.type === "output" ? [event.text] : [])).join("");
		expect(text).toBe("가한나");
	});
});

describe("refusals come before anything starts", () => {
	it.each<readonly [string, () => Promise<{ readonly kind: string; readonly error?: { readonly message: string } }>]>([
		["hand with input", () => launchHand(ports(), { input: { messages: ["hi"] } } as never)],
		["hand with listen", () => launchHand(ports(), { listen: "unix://" } as never)],
		["headless with a print mode", () => launchHeadless(ports(), { mode: "json" } as never)],
		["a fork with a session path", () => launchInteractive(ports(), { session: { fork: "a", path: "b" } })],
		["an invalid session id", () => launchInteractive(ports(), { session: { id: "../x" } })],
		["rpc with @files", () => launchRpc(ports(), { input: { files: ["a.md"] } } as never)],
		["an unknown option field", () => launchRpc(ports(), { sesion: {} } as never)],
		["a key that is not a readable handle", () => launchHand(ports(), { api_key: CANARY } as never)],
		["print with no input", () => launchPrint(ports(), { mode: "json" } as never)],
		["print with options that are not an object", () => launchPrint(ports(), null as never)],
		["rpc with options that are not an object", () => launchRpc(ports(), [] as never)],
		["interactive with listen", () => launchInteractive(ports(), { listen: "unix://x" } as never)],
		["interactive with a print mode", () => launchInteractive(ports(), { mode: "json" } as never)],
		[
			"print with presenter",
			() =>
				launchPrint(ports(), { input: { messages: ["x"] }, mode: "json", presenter: { bootstrap_fd: 4 } } as never),
		],
		["rpc with tui_mode", () => launchRpc(ports(), { tui_mode: "regular" } as never)],
		["headless with multi_session", () => launchHeadless(ports(), { multi_session: true } as never)],
		["hand with gated", () => launchHand(ports(), { gated: { grok_neo: true } } as never)],
		[
			"a message that begins with @",
			() => launchPrint(ports(), { input: { messages: ["@notes.md"] }, mode: "json" }),
		],
		[
			"interactive with a message that begins with @",
			() => launchInteractive(ports(), { input: { messages: ["ok", "@x"] } }),
		],
	])("%s", async (_case, launch) => {
		expect(await launch()).toMatchObject({ kind: "error", error: { code: "invalid_input" } });
		expect(spawned).toEqual([]);
	});

	it("answers launch_failed when the engine cannot start", async () => {
		expect(await launchHand(ports({}, join(root, "no-such-engine")), {})).toMatchObject({
			kind: "error",
			error: { code: "launch_failed" },
		});
	});
});

describe("the other launch modes", () => {
	it("interactive resolves with the exit code", async () => {
		expect(await launchInteractive(ports({ FAKE_ENGINE_EXIT: "3" }), { session: { id: "s-1" } })).toEqual({
			kind: "ok",
			value: { exit_code: 3, session: "s-1" },
			diagnostics: [],
		});
	});

	it("rpc on an address answers the address; on stdio, the streams; stop ends it", async () => {
		const listening = await launchRpc(ports({ FAKE_ENGINE_HOLD: "1" }), { listen: "unix:///tmp/x.sock" });
		if (listening.kind !== "ok" || !("address" in listening.value)) throw new Error("expected an address");
		expect(listening.value.address).toBe("unix:///tmp/x.sock");
		expect(spawned[0]?.args).toEqual([FAKE_ENGINE, "--mode", "rpc", "--listen", "unix:///tmp/x.sock"]);
		await listening.value.stop();
		expect(() => process.kill(listening.value.pid ?? 0, 0)).toThrow();
		const stdio = await launchRpc(ports({ FAKE_ENGINE_HOLD: "1" }), {});
		if (stdio.kind !== "ok" || !("stdio" in stdio.value)) throw new Error("expected stdio");
		expect(stdio.value.stdio.output).not.toBeNull();
		await stdio.value.stop();
	});

	it("hand and headless answer their socket", async () => {
		const hand = await launchHand(ports({ FAKE_ENGINE_HOLD: "1" }), {});
		expect(hand.kind === "ok" && hand.value.socket).toBe(join(root, "agent", "rpc", "hand.sock"));
		if (hand.kind === "ok") await hand.value.stop();
		const headless = await launchHeadless(ports({ FAKE_ENGINE_HOLD: "1" }), {});
		expect(headless.kind === "ok" && headless.value.socket).toBe(join(root, "agent", "rpc", "headless.sock"));
		if (headless.kind === "ok") await headless.value.stop();
	});
});

describe("the launch key travels on its own descriptor (security design 5.5)", () => {
	it.each<readonly [string, () => Readable | ReadableStream<Uint8Array>]>([
		["a node stream", () => Readable.from([Buffer.from(CANARY)])],
		["a web stream", () => new Blob([CANARY]).stream()],
	])("delivers a key from %s to the launched process and to no argv or environment", async (_shape, handle) => {
		const keyOut = join(root, "key-out");
		const run = await launchPrint(ports({ FAKE_ENGINE_KEY_OUT: keyOut }), {
			input: { messages: ["hi"] },
			mode: "json",
			api_key: handle(),
		});
		const events = run.kind === "ok" ? await drain(run.value) : [];
		expect(readFileSync(keyOut, "utf8")).toBe(CANARY);
		expect(JSON.stringify(spawned)).not.toContain(CANARY);
		expect(JSON.stringify(events)).not.toContain(CANARY);
		expect(spawned[0]?.env.SENPI_PRIVATE_FDS).toBe(JSON.stringify({ "api-key": 5 }));
	});

	it("never forwards the caller's own private table to the launched engine", async () => {
		const hand = await launchHand(ports({ SENPI_PRIVATE_FDS: '{"presenter":7}', SENPI_PRIVATE_FDS_FINAL: "1" }), {});
		try {
			expect(spawned).toHaveLength(1);
			expect(spawned[0]?.env).not.toHaveProperty("SENPI_PRIVATE_FDS");
			expect(spawned[0]?.env).not.toHaveProperty("SENPI_PRIVATE_FDS_FINAL");
		} finally {
			if (hand.kind === "ok") await hand.value.stop();
		}
	});

	it("closes the launcher's end of the key channel once the key is written, even when the engine never reads it", async () => {
		const children: ChildProcess[] = [];
		const base = ports({ FAKE_ENGINE_SKIP_KEY: "1", FAKE_ENGINE_HOLD: "1" });
		const unhandled: unknown[] = [];
		const record = (error: unknown) => unhandled.push(error);
		process.on("uncaughtException", record);
		try {
			const recording: LaunchPorts = {
				...base,
				spawn: (cmd, args, options) => {
					const child = base.spawn(cmd, args, options);
					children.push(child);
					return child;
				},
			};
			const run = await launchRpc(recording, { api_key: Readable.from([Buffer.from(CANARY)]) });
			if (run.kind !== "ok") throw new Error("launch refused");
			try {
				const sink: unknown = Reflect.get(children[0]?.stdio ?? [], 5);
				if (!(sink instanceof Writable)) throw new Error("no key channel");
				const closed =
					sink.destroyed ||
					(await once(sink, "close", { signal: AbortSignal.timeout(5_000) }).then(
						() => true,
						() => false,
					));
				expect(closed).toBe(true);
			} finally {
				await run.value.stop();
			}
			await new Promise<void>((done) => setImmediate(done));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("uncaughtException", record);
		}
	});

	it("refuses a launch key on Windows before anything starts", async () => {
		const answer = await launchRpc(
			{ ...ports(), platform: () => "win32" },
			{ api_key: Readable.from([Buffer.from(CANARY)]) },
		);
		expect(answer).toMatchObject({ kind: "error", error: { code: "launch_key_unsupported" } });
		expect(spawned).toEqual([]);
	});

	it("answers launch_failed when the launched engine has no key channel to write to", async () => {
		const base = ports({ FAKE_ENGINE_HOLD: "1" });
		const noKeySlot: LaunchPorts = {
			...base,
			spawn: (cmd, args, options) => {
				const stdio = Array.isArray(options.stdio) ? [...options.stdio] : [];
				stdio[5] = "ignore";
				return base.spawn(cmd, args, { ...options, stdio });
			},
		};
		expect(await launchRpc(noKeySlot, { api_key: Readable.from([Buffer.from(CANARY)]) })).toMatchObject({
			kind: "error",
			error: { code: "launch_failed" },
		});
	});

	it("declares the key to a process the engine starts by name only, with no descriptor", async () => {
		const childOut = join(root, "child-table");
		const run = await launchPrint(ports({ FAKE_ENGINE_CHILD_OUT: childOut }), {
			input: { messages: ["hi"] },
			mode: "json",
			api_key: Readable.from([Buffer.from(CANARY)]),
		});
		if (run.kind === "ok") await drain(run.value);
		expect(JSON.parse(readFileSync(childOut, "utf8"))).toEqual({ "api-key": null });
	});

	const proc = existsSync("/proc/self/fd");
	it(
		proc
			? "closes the descriptor after the read: no entry of /proc/<pid>/fd is the key's socket"
			: "closes the descriptor after the read (no /proc here: could not check /proc/<pid>/fd, checked descriptor 5 is closed)",
		async () => {
			const run = await launchPrint(ports({ FAKE_ENGINE_HOLD: "1" }), {
				input: { messages: ["hi"] },
				mode: "json",
				api_key: Readable.from([Buffer.from(CANARY)]),
			});
			if (run.kind !== "ok") throw new Error("launch refused");
			try {
				await expectKeyClosed(run.value);
			} finally {
				await run.value.stop();
			}
		},
	);

	async function expectKeyClosed(launched: LaunchPrintRun): Promise<void> {
		for await (const event of launched.events) {
			if (event.type !== "event") continue;
			const pid = launched.pid ?? 0;
			const record = event.event as {
				readonly type?: string;
				readonly keySocket?: string;
				readonly closedOnReturn?: boolean;
			};
			expect(record.type).toBe("fake_engine");
			expect(record.closedOnReturn).toBe(true);
			if (proc) {
				const links = readdirSync(`/proc/${pid}/fd`).map((fd) => {
					try {
						return readlinkSync(`/proc/${pid}/fd/${fd}`);
					} catch {
						return "";
					}
				});
				expect(record.keySocket).toMatch(/^socket:\[\d+\]$/u);
				expect(links).not.toContain(record.keySocket);
			} else {
				expect(record.keySocket).toBe("closed");
			}
			return;
		}
		throw new Error("the launched engine printed no record");
	}
});
