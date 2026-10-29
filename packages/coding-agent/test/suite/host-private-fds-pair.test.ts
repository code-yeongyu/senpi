import { spawn, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as privateFds from "../../src/private-fds.ts";
import { preparePrivateFdSpawn } from "../../src/private-fd-spawn.ts";
import { parseTable as oldParseTable } from "../fixtures/private-fd-old-parser.ts";

function inspection() {
	return {
		platform: "win32" as NodeJS.Platform,
		bun: "1.4.4",
		proven: { bun: "1.4.4" } as { readonly bun: string } | false,
		ipc: null as number | null | undefined,
		isSocket: vi.fn(() => false),
		isPipe: vi.fn(() => true),
		clearInherit: vi.fn(() => true),
	};
}

describe("Windows private descriptor pairs (#4859)", () => {
	it.each([
		{ a: [5, 6], b: [6, 7] },
		{ a: 6, b: [6, 7] },
		{ a: [5, 6], b: [7, 6, 8] },
	])("flattens aliases before adopting any entry: %j", (table) => {
		const runtime = inspection();
		const result = privateFds.parseTable(JSON.stringify(table), runtime);
		expect(Object.fromEntries(result.entries)).toEqual({ a: null, b: null });
		expect(result.discard.size).toBe(0);
		expect(runtime.clearInherit).not.toHaveBeenCalled();
	});

	it.each(
		[[], [5], [5, 6, 7], [5, 5], [4, 6], [5, 65], [5.5, 6], [5, "6"], [5, null], [5, 1e30]].map((pair) => ({ pair })),
	)("rejects malformed pair %j per entry", ({ pair }) => {
		const runtime = inspection();
		const result = privateFds.parseTable(JSON.stringify({ bad: pair, good: [9, 10] }), runtime);
		expect(result.parsed).toBe(true);
		expect(Object.fromEntries(result.entries)).toEqual({ bad: null, good: [9, 10] });
		expect(runtime.clearInherit.mock.calls).toEqual([[9], [10]]);
	});

	it("keeps arrays POSIX-incompatible and Windows numbers socket-incompatible", () => {
		expect(privateFds.parseTable('{"a":[5,6]}', { ...inspection(), platform: "linux" }).entries.get("a")).toBeNull();
		expect(privateFds.parseTable('{"a":5}', inspection()).entries.get("a")).toBeNull();
	});

	it.each([
		{ proven: false as const, bun: "1.4.4" },
		{ proven: { bun: "1.4.4" }, bun: "1.4.5" },
		{ proven: { bun: "1.4.4" }, bun: undefined },
	])("fails closed without exact-version proof: %j", (gate) => {
		const runtime = { ...inspection(), ...gate };
		expect(privateFds.parseTable('{"a":[5,6]}', runtime).entries.get("a")).toBeNull();
		expect(runtime.isPipe).not.toHaveBeenCalled();
		expect(runtime.clearInherit).not.toHaveBeenCalled();
	});

	it("ships the release proof disabled", () => {
		expect(privateFds.WINDOWS_PRIVATE_FD_PAIR_PROVEN).toBe(false);
	});

	it("accepts matching proof and clears both handles at receipt, before forwarding", () => {
		const runtime = inspection();
		const result = privateFds.parseTable('{"a":[5,6]}', runtime);
		expect(result.entries.get("a")).toEqual([5, 6]);
		expect(runtime.isPipe.mock.calls).toEqual([[5], [6]]);
		expect(runtime.clearInherit.mock.calls).toEqual([[5], [6]]);
		const transfer = preparePrivateFdSpawn({ stdio: "ignore" }, {}, { kind: "entries", entries: result.entries });
		expect(JSON.parse(transfer.options.env.SENPI_PRIVATE_FDS!)).toEqual({ a: [5, 6] });
		expect(transfer.options.stdio.slice(5, 7)).toEqual([5, 6]);
		// Preparing a hop performs no additional pipe inspections or clearing.
		expect(runtime.isPipe).toHaveBeenCalledTimes(2);
		expect(runtime.clearInherit).toHaveBeenCalledTimes(2);
	});

	it.each([5, 6, undefined])("refuses either IPC descriptor, including an unknown IPC fd: %j", (ipc) => {
		const runtime = { ...inspection(), ipc };
		expect(privateFds.parseTable('{"a":[5,6]}', runtime).entries.get("a")).toBeNull();
		expect(runtime.clearInherit).not.toHaveBeenCalled();
	});

	it.each([5, 6])("refuses a pair when fd %i is not pipe-typed", (bad) => {
		const runtime = { ...inspection(), isPipe: vi.fn((fd: number) => fd !== bad) };
		expect(privateFds.parseTable('{"a":[5,6]}', runtime).entries.get("a")).toBeNull();
		expect(runtime.clearInherit).not.toHaveBeenCalled();
	});

	it("does not adopt a pair whose inherit flag could not be cleared", () => {
		const runtime = { ...inspection(), clearInherit: vi.fn((fd: number) => fd !== 6) };
		expect(privateFds.parseTable('{"a":[5,6]}', runtime).entries.get("a")).toBeNull();
		expect(runtime.clearInherit.mock.calls).toEqual([[5], [6]]);
	});

	it("forwards neither half through a shell", () => {
		const entries = privateFds.parseTable('{"a":[5,6]}', inspection()).entries;
		const transfer = preparePrivateFdSpawn({ shell: true }, {}, { kind: "entries", entries });
		expect(JSON.parse(transfer.options.env.SENPI_PRIVATE_FDS!)).toEqual({ a: null });
		expect(transfer.options.stdio).toHaveLength(3);
	});

	it("old-parser compatibility control fails closed for pairs on every Bun bump", () => {
		const result = oldParseTable('{"a":[5,6],"b":null}');
		expect(result.parsed).toBe(true);
		expect(Object.fromEntries(result.entries)).toEqual({ a: null, b: null });
		expect(result.discard.size).toBe(0);
	});

	it.skipIf(process.platform === "win32")("composes both halves through a real Bun hop on POSIX", async () => {
		const fixture = join(import.meta.dirname, "../fixtures/private-fd-pair.ts");
		const child = spawn("bun", [fixture, "local-hop"], {
			env: { ...process.env, SENPI_PRIVATE_FDS: '{"a":[5,6]}' },
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"],
		});
		const closed = once(child, "close", { signal: AbortSignal.timeout(15_000) });
		const slots: readonly unknown[] = child.stdio;
		const input = slots[5];
		const output = slots[6];
		if (!(input instanceof Socket) || !(output instanceof Socket)) throw new Error("missing pipes");
		let received = "";
		let report = "";
		let errors = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			report += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		output.on("data", (chunk: Buffer) => {
			received += chunk.toString();
		});
		output.resume();
		input.end("ping");
		try {
			expect((await closed)[0], errors).toBe(0);
			expect(received).toBe("echo:ping");
			expect(JSON.parse(report)).toEqual({ closed: [true, true] });
		} finally {
			input.destroy();
			output.destroy();
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
	});

	it("captures and clears before the compiled entry can spawn (spike item 9)", () => {
		const source = readFileSync(join(import.meta.dirname, "../../src/bun/cli.ts"), "utf8");
		const imports = [...source.matchAll(/^import .*?["']([^"']+)["'];/gm)].map((match) => match[1]);
		expect(imports.slice(0, 2)).toEqual(["./sandbox-env-setup.ts", "../private-fds.ts"]);
	});
});

describe.skipIf(process.platform !== "win32")("compiled Bun Windows pair", () => {
	it("round-trips through a hop and destroys both handles", async () => {
		const root = await mkdtemp(join(tmpdir(), "private-fd-pair-"));
		const executable = join(root, "private-pair.exe");
		const fixture = join(import.meta.dirname, "../fixtures/private-fd-pair.ts");
		try {
			const build = spawn("bun", ["build", "--compile", fixture, "--outfile", executable], { stdio: "pipe" });
			const built = once(build, "close", { signal: AbortSignal.timeout(120_000) });
			let errors = "";
			build.stderr?.on("data", (chunk: Buffer) => {
				errors += chunk.toString();
			});
			expect((await built)[0], errors).toBe(0);
			const stdio: StdioOptions = ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"];
			const child = spawn(executable, ["hop"], { stdio, env: { ...process.env, SENPI_PRIVATE_FDS: '{"a":[5,6]}' } });
			const closed = once(child, "close", { signal: AbortSignal.timeout(30_000) });
			const slots: readonly unknown[] = child.stdio;
			const input = slots[5];
			const output = slots[6];
			if (!(input instanceof Socket) || !(output instanceof Socket)) throw new Error("missing pipes");
			let received = "";
			let report = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				report += chunk.toString();
			});
			output.on("data", (chunk: Buffer) => {
				received += chunk.toString();
			});
			output.resume();
			input.end("ping");
			try {
				expect((await closed)[0]).toBe(0);
				expect(received).toBe("echo:ping");
				expect(JSON.parse(report)).toEqual({ closed: [true, true] });
			} finally {
				input.destroy();
				output.destroy();
				if (child.exitCode === null && child.signalCode === null) child.kill();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 150_000);
});
