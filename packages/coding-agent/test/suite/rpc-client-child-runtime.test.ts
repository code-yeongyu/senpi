/**
 * The RPC client starts its child on the runtime the client itself runs on (senpi#6036).
 *
 * A client on Bun that started a Node child handed it a process that refuses to open session state
 * (S21b K9.a, senpi#5822): the child answered the steering message and exited, so every Bun-hosted
 * RPC test failed on that refusal instead of on the behavior it covers. The child has to be the
 * runtime this client runs on, and the launcher's pin has to name it, or the launcher re-execs
 * through a wrapper a SIGTERM cannot take back (#3272).
 *
 * The file runs under Bun (`test/bun-hosted-tests.ts`) because that is the runtime where the two
 * choices differ: under Node the client starts a Node child either way.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ChildRuntime {
	/** The runtime the child actually started on, as the child itself reports it. */
	bun: boolean;
	/** The launcher pin the client handed the child. */
	pin: string | null;
}

function writeRuntimeRecorderChild(): { cliPath: string; recordFile: string } {
	const dir = mkdtempSync(join(tmpdir(), "senpi-rpc-client-runtime-"));
	tempDirs.push(dir);
	const recordFile = join(dir, "runtime.json");
	const cliPath = join(dir, "child.mjs");
	writeFileSync(
		cliPath,
		`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
	bun: process.versions.bun !== undefined,
	pin: process.env.SENPI_RUNTIME ?? null,
}));
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		const request = JSON.parse(line);
		process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { commands: [] } }) + "\\n");
	}
});
process.stdin.resume();
`,
	);
	return { cliPath, recordFile };
}

test("spawns its CLI child on its own runtime, pinned to it", async () => {
	const { cliPath, recordFile } = writeRuntimeRecorderChild();
	const client = new RpcClient({ cliPath });
	await client.start();
	try {
		await client.getCommands();
	} finally {
		await client.stop();
	}

	const recorded = JSON.parse(readFileSync(recordFile, "utf8")) as ChildRuntime;
	const runsOnBun = process.versions.bun !== undefined;
	expect(recorded.bun).toBe(runsOnBun);
	expect(recorded.pin).toBe(runsOnBun ? "bun" : "node");
}, 30_000);
