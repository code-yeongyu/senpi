import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import { Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fixture = join(import.meta.dirname, "../fixtures/private-fd-hop.ts");

async function exchange(mode: string, table = '{"sample-channel":5}') {
	const child = spawn(process.execPath, [fixture, mode], {
		env: {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			SENPI_PRIVATE_FDS: table,
			PI_OFFLINE: "1",
		},
		stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"],
	});
	const closed = once(child, "close", { signal: AbortSignal.timeout(15_000) });
	const stdio: readonly unknown[] = child.stdio;
	const channel = stdio[5];
	if (!(channel instanceof Socket)) throw new Error("fixture did not receive a duplex");
	let received = "";
	let stderr = "";
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	channel.on("data", (chunk: Buffer) => {
		received += chunk.toString();
		if (received === "claimed:ping" || received === "engine-claimed") channel.end();
	});
	channel.on("error", () => channel.destroy());
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	channel.write("ping");
	try {
		const [code] = await closed;
		return { code, received, stderr, stdout };
	} finally {
		channel.destroy();
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}

function reports(stderr: string): unknown[] {
	return stderr
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line): unknown => JSON.parse(line));
}

// #4749: actual inherited sockets cross the production supervisor spawn, not a mocked spawn table.
describe("private host descriptors", () => {
	it.skipIf(process.platform === "win32")("forwards the named duplex into the engine", async () => {
		// given a launcher-created duplex, when the supervisor starts its engine
		const result = await exchange("supervisor");
		// then the engine can reply through that same private channel
		expect(result, result.stderr).toMatchObject({ code: 0, received: "engine:ping" });
	});

	it("never forwards a private channel into an unrelated child", async () => {
		// given the same bootstrap, when an ordinary child is spawned
		const result = await exchange("unrelated");
		// then both descriptor authority and the environment selector are absent
		expect(JSON.parse(result.received)).toEqual({ childExit: 2, leakedTable: false });
	});

	const state = (fields: { available?: boolean; declared?: boolean; present?: boolean; unparseable?: boolean }) => ({
		available: false,
		repeated: false,
		declared: false,
		present: true,
		unparseable: false,
		...fields,
	});
	const engine = (fields: { available?: boolean; declared?: boolean; present?: boolean; unparseable?: boolean }) => ({
		mode: "engine-report",
		present: true,
		declared: true,
		unparseable: false,
		available: false,
		...fields,
	});
	const nested = { mode: "nested", present: false, declared: false, unparseable: false, available: false };

	it.skipIf(process.platform === "win32")("claims the named channel only once", async () => {
		const result = await exchange("receiver");
		expect(JSON.parse(result.stdout)).toEqual(state({ available: true, declared: true }));
		expect(result.received).toBe("claimed:ping");
	});

	it("declares a null entry without adopting any descriptor", async () => {
		// given a desktop host that declares the channel on a path with no descriptor
		const result = await exchange("receiver", '{"sample-channel":null}');
		// then the name is declared, and the open fd 5 is not adopted
		expect(JSON.parse(result.stdout)).toEqual(state({ declared: true }));
		expect(result.received).toBe("");
	});

	it.each([
		['{"sample-channel":4}', "a reserved descriptor"],
		['{"sample-channel":5,"alias":5}', "a descriptor named twice"],
		['{"sample-channel":65}', "a descriptor above the range"],
		['{"sample-channel":6}', "a descriptor that is not open"],
		['{"sample-channel":"5"}', "a string"],
		['{"sample-channel":true}', "a boolean"],
	])("keeps the name declared but unavailable for %s (%s)", async (table) => {
		const result = await exchange("receiver", table);
		expect(JSON.parse(result.stdout)).toEqual(state({ declared: true }));
		expect(result.received).toBe("");
	});

	it.each([
		["", state({ present: false })],
		['{"bad name":5}', state({})],
		["not-json", state({ unparseable: true })],
		["[5]", state({ unparseable: true })],
	])("never declares the channel for table %j", async (table, expected) => {
		const result = await exchange("receiver", table);
		expect(JSON.parse(result.stdout)).toEqual(expected);
		expect(result.received).toBe("");
	});

	it.skipIf(process.platform === "win32")(
		"canary: an invalid entry beside the channel leaves the channel working",
		async () => {
			const result = await exchange("receiver", '{"sample-channel":5,"other":{},"bad name":7}');
			expect(JSON.parse(result.stdout)).toEqual(state({ available: true, declared: true }));
			expect(result.received).toBe("claimed:ping");
		},
	);

	it("canary: a garbage table declares the names it still quotes, all unavailable", async () => {
		const result = await exchange("receiver", '{"sample-channel":5');
		expect(JSON.parse(result.stdout)).toEqual(state({ declared: true }));
		expect(result.received).toBe("");
	});

	it.skipIf(process.platform === "win32")("forwards a null declaration hop to hop into the engine", async () => {
		// given a null entry, when the supervisor starts its engine
		const result = await exchange("supervisor-report", '{"sample-channel":null}');
		// then the engine sees the declaration without a channel, and its nested host sees neither
		expect(result.code, result.stderr).toBe(0);
		expect(reports(result.stderr)).toEqual([nested, engine({})]);
		expect(result.received).toBe("");
	});

	it.skipIf(process.platform === "win32")(
		"carries an unparseable table to the engine as present but unavailable",
		async () => {
			const result = await exchange("supervisor-report", "%%%");
			expect(result.code, result.stderr).toBe(0);
			expect(reports(result.stderr)).toEqual([nested, engine({ declared: false, unparseable: true })]);
			expect(result.received).toBe("");
		},
	);

	it.skipIf(process.platform === "win32")("ends the chain at the engine: a nested host inherits nothing", async () => {
		// given the engine received the named duplex
		const result = await exchange("supervisor-report");
		// then a host it starts before claiming gets neither the table nor the descriptor; the engine still claims it
		expect(result.code, result.stderr).toBe(0);
		expect(reports(result.stderr)).toEqual([nested, engine({ available: true })]);
		expect(result.received).toBe("engine-claimed");
	});

	it.runIf(process.platform === "win32")("does not forward unsupported Windows descriptors", async () => {
		// given a Windows launcher, when it attempts the POSIX descriptor path
		const result = await exchange("supervisor");
		// then no stream reaches the engine
		expect(result.received).toBe("");
		expect(result.code).not.toBe(0);
	});
});

const probeFixture = join(import.meta.dirname, "../fixtures/private-fd-probe.ts");

/** The runtimes a launcher may start: this test's runtime, and Node when the host has a working one. */
function works(command: string): boolean {
	const probed = spawnSync(command, ["--version"], { encoding: "utf8" });
	return probed.status === 0 && probed.stdout.trim().length > 0;
}

/** [label, command, skip reason]: a runtime that is not installed is skipped with that reason. */
function runtimes(): [string, string, string | undefined][] {
	const found: [string, string, string | undefined][] = [["current", process.execPath, undefined]];
	for (const command of ["node", "bun"]) {
		const isCurrent = command === "bun" ? Boolean(process.versions.bun) : !process.versions.bun;
		if (!isCurrent) found.push([command, command, works(command) ? undefined : `${command} is not installed`]);
	}
	return found;
}

async function probe(runtime: string, args: readonly string[], table: string, stdio: StdioOptions) {
	const child = spawn(runtime, [...args], {
		env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SENPI_PRIVATE_FDS: table, PI_OFFLINE: "1" },
		stdio,
	});
	const closed = once(child, "close", { signal: AbortSignal.timeout(20_000) });
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const slots: readonly unknown[] = child.stdio;
	for (const slot of slots.slice(3)) if (slot instanceof Socket) slot.end();
	child.on("message", () => {});
	const [code] = await closed;
	return { code, stdout, stderr };
}

const pipes = (...fds: number[]): StdioOptions => {
	const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
	for (let fd = 3; fd <= Math.max(...fds); fd++) stdio.push(fds.includes(fd) ? "pipe" : "ignore");
	return stdio;
};

// #4771 review: only a handed-over socket in the range every runtime marks close-on-exec is adopted.
for (const [label, runtime, missing] of runtimes()) {
	describe.skipIf(process.platform === "win32" || missing !== undefined)(
		`private descriptor adoption under ${label}${missing === undefined ? "" : ` (skipped: ${missing})`}`,
		() => registerAdoptionCases(runtime),
	);
}

function registerAdoptionCases(runtime: string): void {
	it("a tool child with ignored stdio holds no private descriptor, even one above the protected range", async () => {
		// 24 and 64 sit past every runtime's startup close-on-exec sweep (Node on Linux leaks from 24 up).
		const table = '{"sample-channel":5,"high":24,"top":64}';
		const result = await probe(runtime, [probeFixture, "leak-probe"], table, pipes(5, 24, 64));
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			open: "",
			high: { declared: true, available: false },
			top: { declared: true, available: false },
		});
	});

	it("a named descriptor the launcher never passed is declared but unavailable", async () => {
		for (const table of ['{"sample-channel":5}', '{"sample-channel":6}', '{"sample-channel":9}']) {
			const result = await probe(runtime, [probeFixture, "report"], table, ["ignore", "pipe", "pipe"]);
			expect(JSON.parse(result.stdout), table).toEqual({
				available: false,
				declared: true,
				present: true,
				unparseable: false,
			});
		}
	});

	it("a descriptor replaced by execve is declared but unavailable", async () => {
		const hop = `process.execve(process.execPath, [process.execPath, ${JSON.stringify(probeFixture)}, "report"], process.env)`;
		const result = await probe(runtime, ["-e", hop], '{"sample-channel":5}', pipes(5));
		expect(JSON.parse(result.stdout), result.stderr).toEqual({
			available: false,
			declared: true,
			present: true,
			unparseable: false,
		});
	});

	it("the runtime's own IPC channel is never adopted", async () => {
		const result = await probe(runtime, [probeFixture, "report"], '{"sample-channel":5}', [
			"ignore",
			"pipe",
			"pipe",
			"ignore",
			"ignore",
			"ipc",
		]);
		expect(JSON.parse(result.stdout), result.stderr).toEqual({
			available: false,
			declared: true,
			present: true,
			unparseable: false,
		});
	});

	it("a second spawn still declares every name, without the descriptor", async () => {
		const result = await probe(runtime, [probeFixture, "double-spawn"], '{"sample-channel":5}', pipes(5));
		expect(JSON.parse(result.stdout), result.stderr).toEqual(['{"sample-channel":5}', '{"sample-channel":null}']);
	});
}
