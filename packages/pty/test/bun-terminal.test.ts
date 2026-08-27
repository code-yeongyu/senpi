import { describe, expect, it } from "vitest";
import { TerminalSession } from "../src/session.ts";
import {
	type BunRuntime,
	type BunTerminal,
	createBunTerminalSession,
	isBunTerminalEnabled,
} from "../src/session-bun.ts";

const bunVersions = { bun: "1.4.0" };
const nodeVersions = {};

function fakeRuntime() {
	let dataHandler: ((terminal: BunTerminal, data: Uint8Array) => void) | undefined;
	let resolveExit: ((code: number) => void) | undefined;
	const writes: string[] = [];
	const resizes: string[] = [];
	const kills: string[] = [];
	const runtime: BunRuntime = {
		spawn(_command, options) {
			dataHandler = options.terminal.data;
			return {
				terminal: {
					write(data) {
						writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
					},
					resize(cols, rows) {
						resizes.push(`${cols}x${rows}`);
					},
				},
				exited: new Promise((resolve) => {
					resolveExit = resolve;
				}),
				kill(signal) {
					kills.push(signal ?? "SIGTERM");
					resolveExit?.(143);
				},
			};
		},
	};
	return { runtime, dataHandler: () => dataHandler, resolveExit: () => resolveExit, writes, resizes, kills };
}

describe("Bun terminal gate", () => {
	it.each([
		["node off", nodeVersions, {}, false],
		["node on", nodeVersions, { SENPI_BUN_TERMINAL: "1" }, false],
		["bun off", bunVersions, {}, false],
		["bun on", bunVersions, { SENPI_BUN_TERMINAL: "true" }, true],
	])("%s", (_name, versions, env, expected) => {
		expect(isBunTerminalEnabled(env, versions)).toBe(expected);
	});

	it("accepts the documented truthy values and rejects other values", () => {
		for (const value of ["1", "true", "yes", "on", " TRUE "]) {
			expect(isBunTerminalEnabled({ SENPI_BUN_TERMINAL: value }, bunVersions)).toBe(true);
		}
		for (const value of ["", "0", "false", "no", "off"]) {
			expect(isBunTerminalEnabled({ SENPI_BUN_TERMINAL: value }, bunVersions)).toBe(false);
		}
	});
});

describe("Bun terminal session adapter", () => {
	it("selects Bun only for a Bun runtime with the opt-in flag", async () => {
		const fake = fakeRuntime();
		const session = new TerminalSession(
			{ command: "bash" },
			{
				env: { SENPI_BUN_TERMINAL: "1" },
				runtimeVersions: { ...process.versions, bun: "1.4.0" },
				bunRuntime: fake.runtime,
			},
		);
		session.start();
		fake.resolveExit()?.(0);
		await session.waitExit();
		expect(session.backend).toBe("bun");
	});

	it("forwards data, writes, resize, kill, and exit", async () => {
		const fake = fakeRuntime();
		const chunks: string[] = [];
		const session = createBunTerminalSession(
			{ command: "bash", args: ["-i"], cols: 80, rows: 24 },
			(data) => chunks.push(new TextDecoder().decode(data)),
			fake.runtime,
		);
		fake.dataHandler()?.(undefined as never, new TextEncoder().encode("hello"));
		session.write("echo hi");
		session.resize(120, 40);
		session.kill("SIGTERM");
		const exit = await session.waitExit?.();

		expect(chunks).toEqual(["hello"]);
		expect(fake.writes).toEqual(["echo hi"]);
		expect(fake.resizes).toEqual(["120x40"]);
		expect(fake.kills).toEqual(["SIGTERM"]);
		expect(exit).toEqual({ exitCode: 143, signal: null, timedOut: false });
	});
});
