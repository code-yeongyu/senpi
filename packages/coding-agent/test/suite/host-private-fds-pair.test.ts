import { spawn, type SpawnOptions, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeDiscarded, parseTable } from "../../src/private-fds.ts";
import { preparePrivateFdSpawn } from "../../src/private-fd-spawn.ts";
import { inheritedDuplex } from "../../src/utils/inherited-duplex.ts";
import { parseTable as oldParseTable } from "../fixtures/private-fd-old-parser.ts";

vi.mock("node:fs", { spy: true });

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

function forwardPair(options: SpawnOptions) {
	// Exercise the wire shape without widening main's number-only types in the seam commit.
	const transfer: ReturnType<typeof preparePrivateFdSpawn> = Reflect.apply(preparePrivateFdSpawn, undefined, [
		options,
		{},
		{ kind: "entries", entries: new Map([["a", [5, 6]]]) },
	]);
	return transfer;
}

describe("Windows private descriptor pairs (#4859)", () => {
	// #5137: Windows Stats exposes FIFO mode bits even when isFIFO() returns false.
	it.each([
		{ mode: 0o010600, accepted: true },
		{ mode: 0o010000, accepted: true },
		{ mode: 0o100600, accepted: false },
		{ mode: 0o140600, accepted: false },
		{ mode: 0o020600, accepted: false },
	])("default pipe check classifies mode $mode without isFIFO", ({ mode, accepted }) => {
		const stat = Object.assign(fs.fstatSync(1), { mode, isFIFO: () => false });
		const fstat = vi.mocked(fs.fstatSync).mockReturnValue(stat);
		const { isPipe: _isPipe, ...runtime } = inspection();
		try {
			expect(parseTable('{"a":[5,6]}', runtime).entries.get("a")).toEqual(accepted ? [5, 6] : null);
		} finally {
			fstat.mockReset();
		}
	});

	// #5137: adoption must use the same pipe check as the parser, or Windows accepts a pair it never adopts.
	it.each([
		{ mode: 0o010600, adopted: true },
		{ mode: 0o100600, adopted: false },
	])("pair adoption classifies mode $mode without isFIFO", async ({ mode, adopted }) => {
		const root = await mkdtemp(join(tmpdir(), "private-fd-adopt-"));
		const readFd = fs.openSync(join(root, "pipe"), "w+");
		const writeFd = fs.openSync(join(root, "pipe"), "r+");
		const stat = Object.assign(fs.fstatSync(readFd), { mode, isFIFO: () => false, isSocket: () => false });
		const fstat = vi.mocked(fs.fstatSync).mockReturnValue(stat);
		let channel: ReturnType<typeof inheritedDuplex>;
		try {
			channel = inheritedDuplex([readFd, writeFd]);
		} finally {
			fstat.mockReset();
		}
		try {
			expect(channel !== undefined).toBe(adopted);
		} finally {
			if (channel === undefined) {
				fs.closeSync(readFd);
				fs.closeSync(writeFd);
			} else {
				const done = once(channel, "close");
				channel.destroy();
				await done;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ label: "pair/pair", table: { a: [5, 6], b: [6, 7] }, cleared: [5, 6, 7] },
		{ label: "bare/pair", table: { a: 6, b: [6, 7] }, cleared: [6, 7] },
		{ label: "malformed-pair alias", table: { a: [5, 6], b: [7, 6, 8] }, cleared: [5, 6, 7, 8] },
	])("N1/N2 $label entries are null without double adoption", ({ table, cleared }) => {
		const runtime = inspection();
		const result = parseTable(JSON.stringify(table), runtime);
		expect(Object.fromEntries(result.entries)).toEqual({ a: null, b: null });
		expect(result.discard.size).toBe(0);
		expect(runtime.clearInherit.mock.calls).toEqual(cleared.map((fd) => [fd]));
	});

	// #4859: receipt protection applies even when an alias prevents adoption.
	it("N9 clears both descriptors in the pair and bare alias probe", () => {
		const runtime = inspection();
		const result = parseTable('{"a":[5,6],"b":6}', runtime);
		expect(Object.fromEntries(result.entries)).toEqual({ a: null, b: null });
		expect(runtime.clearInherit.mock.calls).toEqual([[5], [6]]);
	});

	it("N9 clears the whole table before any pipe type inspection", () => {
		const events: string[] = [];
		parseTable('{"a":[5,6],"b":[9,10]}', {
			...inspection(),
			clearInherit: (fd) => {
				events.push(`clear:${fd}`);
				return true;
			},
			isPipe: (fd) => {
				events.push(`pipe:${fd}`);
				return true;
			},
		});
		expect(events).toEqual(["clear:5", "clear:6", "clear:9", "clear:10", "pipe:5", "pipe:6", "pipe:9", "pipe:10"]);
	});

	it("N1 counts a POSIX socket alias inside a refused pair", () => {
		const result = parseTable('{"a":5,"b":[5,6]}', {
			...inspection(),
			platform: "linux",
			isSocket: () => true,
		});
		expect(Object.fromEntries(result.entries)).toEqual({ a: null, b: null });
		expect([...result.discard]).toEqual([5]);
	});

	it.each([
		{ label: "empty", pair: [], cleared: [] },
		{ label: "one element", pair: [5], cleared: [5] },
		{ label: "three elements", pair: [5, 6, 7], cleared: [5, 6, 7] },
		{ label: "equal elements", pair: [5, 5], cleared: [5] },
		{ label: "reserved descriptor", pair: [4, 6], cleared: [6] },
		{ label: "above range", pair: [5, 65], cleared: [5] },
		{ label: "fractional descriptor", pair: [5.5, 6], cleared: [6] },
		{ label: "string descriptor", pair: [5, "6"], cleared: [5] },
		{ label: "null descriptor", pair: [5, null], cleared: [5] },
		{ label: "unsafe integer", pair: [5, 1e30], cleared: [5] },
	])("N3 malformed $label is a null declaration", ({ pair, cleared }) => {
		const runtime = inspection();
		const result = parseTable(JSON.stringify({ bad: pair }), runtime);
		expect(result.parsed).toBe(true);
		expect(result.entries.get("bad")).toBeNull();
		expect(runtime.clearInherit.mock.calls).toEqual(cleared.map((fd) => [fd]));
	});

	it("N3 malformed sibling leaves an independent valid pair usable", () => {
		const result = parseTable('{"bad":[5],"good":[9,10]}', inspection());
		expect(result.entries.get("good")).toEqual([9, 10]);
	});

	it("N4 POSIX array stays a null declaration", () => {
		expect(parseTable('{"a":[5,6]}', { ...inspection(), platform: "linux" }).entries.get("a")).toBeNull();
	});

	it("N4 win32 bare number stays a null declaration", () => {
		const runtime = inspection();
		expect(parseTable('{"a":5}', runtime).entries.get("a")).toBeNull();
		expect(runtime.clearInherit.mock.calls).toEqual([[5]]);
	});

	it.each([
		{ label: "false proof", proven: false as const, bun: "1.4.4" },
		{ label: "version mismatch", proven: { bun: "1.4.4" }, bun: "1.4.5" },
		{ label: "no Bun version", proven: { bun: "1.4.4" }, bun: undefined },
	])("gate $label refuses pairs after receipt clearing without type inspection", ({ label: _label, ...gate }) => {
		const runtime = { ...inspection(), ...gate };
		expect(parseTable('{"a":[5,6]}', runtime).entries.get("a")).toBeNull();
		expect(runtime.isPipe).not.toHaveBeenCalled();
		expect(runtime.clearInherit.mock.calls).toEqual([[5], [6]]);
	});

	it("gate default release proof refuses win32 pairs", () => {
		expect(parseTable('{"a":[5,6]}', { platform: "win32", bun: "1.4.4" }).entries.get("a")).toBeNull();
	});

	it("gate matching proof accepts the ordered pair", () => {
		expect(parseTable('{"a":[5,6]}', inspection()).entries.get("a")).toEqual([5, 6]);
	});

	it("pair type gate inspects both descriptors", () => {
		const runtime = inspection();
		parseTable('{"a":[5,6]}', runtime);
		expect(runtime.isPipe.mock.calls).toEqual([[5], [6]]);
	});

	it("N9 receipt invokes inherit clearing for both adopted handles", () => {
		const runtime = inspection();
		parseTable('{"a":[5,6]}', runtime);
		expect(runtime.clearInherit.mock.calls).toEqual([[5], [6]]);
	});

	it("pair forwarding carries both stdio slots atomically", () => {
		const transfer = forwardPair({ stdio: "ignore" });
		expect(transfer.options.stdio.slice(5, 7)).toEqual([5, 6]);
		expect(JSON.parse(transfer.options.env.SENPI_PRIVATE_FDS ?? "")).toEqual({ a: [5, 6] });
	});

	it("pair shell forwarding carries neither stdio half", () => {
		const transfer = forwardPair({ shell: true });
		expect(JSON.parse(transfer.options.env.SENPI_PRIVATE_FDS ?? "")).toEqual({ a: null });
		expect(transfer.options.stdio).toHaveLength(3);
	});

	it.each([5, 6, undefined])("pair IPC descriptor %j refuses adoption", (ipc) => {
		const runtime = { ...inspection(), ipc };
		expect(parseTable('{"a":[5,6]}', runtime).entries.get("a")).toBeNull();
		expect(runtime.clearInherit.mock.calls).toEqual([[5], [6]]);
	});

	it.each([5, 6])("pair non-pipe descriptor %i refuses adoption", (bad) => {
		const runtime = { ...inspection(), isPipe: vi.fn((fd: number) => fd !== bad) };
		expect(parseTable('{"a":[5,6]}', runtime).entries.get("a")).toBeNull();
		expect(runtime.clearInherit.mock.calls).toEqual([[5], [6]]);
	});

	it("N9 clearing failure leaves the pair unavailable", () => {
		const runtime = { ...inspection(), clearInherit: (fd: number) => fd !== 6 };
		expect(parseTable('{"a":[5,6]}', runtime).entries.get("a")).toBeNull();
	});

	it("N9 receipt attempts both clear calls even when one fails", () => {
		const runtime = { ...inspection(), clearInherit: vi.fn((fd: number) => fd !== 6) };
		parseTable('{"a":[5,6]}', runtime);
		expect(runtime.clearInherit.mock.calls).toEqual([[5], [6]]);
	});

	// #4859 review: a handle whose inherit flag stays set must not reach any child this process spawns.
	it.each([
		{ label: "pair half", table: '{"a":[5,6]}', failing: [6], discard: [6] },
		{ label: "both pair halves", table: '{"a":[5,6]}', failing: [5, 6], discard: [5, 6] },
		{ label: "bare number", table: '{"a":7}', failing: [7], discard: [7] },
		{ label: "aliased handle", table: '{"a":[5,6],"b":6}', failing: [6], discard: [6] },
	])("N9 clearing failure discards the $label", ({ table, failing, discard }) => {
		const runtime = { ...inspection(), clearInherit: (fd: number) => !failing.includes(fd) };
		const result = parseTable(table, runtime);
		expect([...result.entries.values()].every((entry) => entry === null)).toBe(true);
		expect([...result.discard].sort((left, right) => left - right)).toEqual(discard);
	});

	it("N9 clearing failure never discards the runtime IPC descriptor", () => {
		const runtime = { ...inspection(), ipc: 6, clearInherit: () => false };
		const result = parseTable('{"a":[5,6]}', runtime);
		expect([...result.discard]).toEqual([5]);
	});

	it("discard closes the descriptor it names", () => {
		const close = vi.fn();
		closeDiscarded(7, close);
		expect(close.mock.calls).toEqual([[7]]);
	});

	it("discard treats an already-closed descriptor as nothing to close", () => {
		const close = () => {
			throw Object.assign(new Error("bad file descriptor"), { code: "EBADF" });
		};
		expect(() => closeDiscarded(7, close)).not.toThrow();
	});

	it.each(["EIO", "EINTR", undefined])("discard rethrows a %s close failure", (code) => {
		const failure = Object.assign(new Error("close failed"), code === undefined ? {} : { code });
		const close = () => {
			throw failure;
		};
		expect(() => closeDiscarded(7, close)).toThrow(failure);
	});

	it("old-parser compatibility control refuses pairs on every Bun bump", () => {
		const result = oldParseTable('{"a":[5,6],"b":null}');
		expect(result.parsed).toBe(true);
		expect(Object.fromEntries(result.entries)).toEqual({ a: null, b: null });
		expect(result.discard.size).toBe(0);
	});

	// #4859: invalid names must not change POSIX adoption or close the valid channel.
	it("POSIX ignores invalid-name entries when counting descriptor aliases", () => {
		const result = parseTable('{"a":7,"Bad":7}', { ...inspection(), platform: "linux", isSocket: () => true });
		expect({ entries: Object.fromEntries(result.entries), discard: [...result.discard] }).toEqual({
			entries: { a: 7 },
			discard: [],
		});
	});

	it.skipIf(process.platform === "win32")("composes both halves through a real Bun hop on POSIX", async () => {
		const fixture = join(import.meta.dirname, "../fixtures/private-fd-pair.ts");
		// A fixture mode, not a binary: kept out of the literal argv so knip does not read it as one.
		const mode = "local-hop";
		const child = spawn("bun", [fixture, mode], {
			env: { ...process.env, SENPI_PRIVATE_FDS: '{"a":[5,6]}' },
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"],
		});
		const closed = once(child, "close", { signal: AbortSignal.timeout(15_000) });
		const slots: readonly unknown[] = child.stdio;
		const input = slots[5];
		const output = slots[6];
		if (!(input instanceof Socket) || !(output instanceof Socket)) throw new Error("missing pipes");
		input.on("error", () => input.destroy());
		output.on("error", () => output.destroy());
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
		// The startup stub sits between them: it spawns nothing, and it must release its filler pipes before the
		// table is adopted (senpi#4602).
		expect(imports.slice(0, 3)).toEqual([
			"./sandbox-env-setup.ts",
			"../modes/rpc/host-startup-beacon.ts",
			"../private-fds.ts",
		]);
	});

	it("releases inherited fillers before the npm entry adopts the private table (senpi#4602)", () => {
		const source = readFileSync(join(import.meta.dirname, "../../src/cli.ts"), "utf8");
		const imports = [...source.matchAll(/^import .*?["']([^"']+)["'];/gm)].map((match) => match[1]);
		expect(imports.slice(0, 3)).toEqual(["./valid-cwd.ts", "./private-fd-startup-release.ts", "./private-fds.ts"]);
	});
});

describe.skipIf(process.platform !== "win32")("non-compiled Bun Windows pair", () => {
	// #5137: cover the source runtime separately from the compiled-runtime proof.
	it("round-trips through a hop and destroys both handles", async () => {
		const fixture = join(import.meta.dirname, "../fixtures/private-fd-pair.ts");
		const mode = "hop";
		const child = spawn("bun", [fixture, mode], {
			env: { ...process.env, SENPI_PRIVATE_FDS: '{"a":[5,6]}' },
			stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"],
		});
		const closed = once(child, "close", { signal: AbortSignal.timeout(30_000) });
		const slots: readonly unknown[] = child.stdio;
		const input = slots[5];
		const output = slots[6];
		if (!(input instanceof Socket) || !(output instanceof Socket)) throw new Error("missing pipes");
		input.on("error", () => input.destroy());
		output.on("error", () => output.destroy());
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
			input.on("error", () => input.destroy());
			output.on("error", () => output.destroy());
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
