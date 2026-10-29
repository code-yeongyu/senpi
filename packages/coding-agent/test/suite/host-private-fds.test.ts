import { spawn } from "node:child_process";
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
		stdio: ["ignore", "ignore", "pipe", "ignore", "ignore", "pipe"],
	});
	const closed = once(child, "close", { signal: AbortSignal.timeout(15_000) });
	const channel = child.stdio[5];
	if (!(channel instanceof Socket)) throw new Error("fixture did not receive a duplex");
	let received = "";
	let stderr = "";
	channel.on("data", (chunk: Buffer) => { received += chunk.toString(); });
	channel.on("error", () => channel.destroy());
	child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	channel.write("ping");
	try {
		const [code] = await closed;
		return { code, received, stderr };
	} finally {
		channel.destroy();
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
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

	it.runIf(process.platform === "win32")("does not forward unsupported Windows descriptors", async () => {
		// given a Windows launcher, when it attempts the POSIX descriptor path
		const result = await exchange("supervisor");
		// then no stream reaches the engine
		expect(result.received).toBe("");
		expect(result.code).not.toBe(0);
	});
});
