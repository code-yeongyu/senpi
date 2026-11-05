// senpi#3566 todo 4: every CLI entry becomes the tool-child role before argument parsing (process + packaging contract).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openChannelListener } from "../../src/modes/rpc/tool-child/channel.ts";
import type { ToolChildMessage } from "../../src/modes/rpc/tool-child/protocol.ts";
import { TOOL_CHILD_JOB_HANDLERS } from "../../src/modes/rpc/tool-child/role.ts";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../src/experimental/source-resolver.ts")).href;
const ENTRIES = ["src/cli.ts", "src/cli-main.ts", "src/rpc-entry.ts", "src/tool-child-main.ts"] as const;

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function run(entry: string, env: Record<string, string>, args: string[]) {
	const child = spawn(
		process.execPath,
		["--import", resolver, resolve(import.meta.dirname, "../..", entry), ...args],
		{
			env: { ...hostSpawnEnv(), ...env },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
		child.once("close", (code) => done({ code, stdout, stderr })),
	);
	return { child, exited };
}

describe.each(ENTRIES)("%s with the tool-child role", (entry) => {
	it("exits 70 before parsing arguments when the channel is missing", async () => {
		const { exited } = run(entry, { SENPI_INTERNAL_ROLE: "tool-child" }, ["--version"]);
		const result = await exited;
		expect(result.code).toBe(70);
		expect(result.stderr).toContain("tool-child: channel unavailable");
		expect(result.stdout).toBe("");
	}, 60_000);

	it("reaches the role entry and says hello on its channel", async () => {
		const root = await mkdtemp(join(tmpdir(), "irb-"));
		roots.push(root);
		const listener = await openChannelListener({ dir: join(root, "ch"), generation: 7 });
		const { child, exited } = run(
			entry,
			{ SENPI_INTERNAL_ROLE: "tool-child", SENPI_TOOL_CHILD_GENERATION: "7", ...listener.env },
			["--version"],
		);
		const channel = await listener.accepted;
		const hello = await new Promise<ToolChildMessage>((done) => channel.onMessage(done));
		expect(hello).toEqual({
			type: "hello",
			generation: 7,
			pid: child.pid,
			protocol: 2,
			jobKinds: Object.keys(TOOL_CHILD_JOB_HANDLERS).sort(),
		});
		channel.close();
		const result = await exited;
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		await listener.close();
	}, 60_000);
});
