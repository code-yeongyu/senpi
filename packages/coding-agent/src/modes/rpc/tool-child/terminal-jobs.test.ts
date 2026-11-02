// senpi#3566 todo 9: the terminal's bash body runs on the tool child (the PTY shell's parent is the child), its launch
// passes the execution barrier (ledgered as pty.spawn, acknowledged before the command's first output reaches the
// server), and its foreground output streams back as job updates.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ToolChildClient } from "./client.ts";
import { TERMINAL_JOB_KINDS } from "./terminal-jobs.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function stringEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

describe.skipIf(process.platform === "win32")("terminal jobs on the tool child", () => {
	it("runs a foreground bash command in the child behind the barrier and streams its output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ttj-"));
		const instance = new ToolChildClient({
			dir: join(dir, "ch"),
			cwd: dir,
			command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
			env: process.env,
		});
		cleanups.push(async () => {
			await instance.close();
			await rm(dir, { recursive: true, force: true });
		});
		await instance.start();
		const marker = join(dir, "ppid");
		const updates: number[] = [];
		const result = (await instance.run(
			TERMINAL_JOB_KINDS.bash,
			{
				params: { command: `echo $PPID > ${marker}; for i in 1 2 3; do echo line-$i; sleep 0.2; done` },
				toolCallId: "t1",
				cwd: dir,
				env: stringEnv(),
				defaultCols: 80,
				defaultRows: 24,
			},
			undefined,
			{ onUpdate: () => updates.push(Date.now()) },
		)) as { content: Array<{ type: string; text?: string }> };
		const text = result.content.map((part) => part.text ?? "").join("");
		expect(text).toContain("line-3");
		expect(Number((await readFile(marker, "utf8")).trim())).toBe(instance.pid);
		const records = (await readFile(join(dir, "ch", "launches.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; api?: string; launchId: string; atMs: number });
		const launch = records.find((record) => record.type === "launch" && record.api === "pty.spawn");
		expect(launch).toBeDefined();
		const ack = records.find((record) => record.type === "launch_ack" && record.launchId === launch?.launchId);
		expect(ack).toBeDefined();
		expect(updates.length).toBeGreaterThan(0);
		expect(ack?.atMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(updates[0] ?? 0);
	}, 60_000);
});
