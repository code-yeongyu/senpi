// senpi#3566 todo 4 (review MEDIUM 4): an own-group launch behind the go-line shim keeps the caller's stdin, reports a
// missing program as the same ENOENT 'error' as an ungated spawn, and runs a custom shell string with that shell.
import realChildProcess from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BarrierClock } from "./barrier-clock.ts";
import { createGatedChildProcess } from "./gated-child-process.ts";
import { WorkerLaunchClient, type WorkerLaunchMessage } from "./worker-launch.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function gated() {
	const messages: WorkerLaunchMessage[] = [];
	const client = new WorkerLaunchClient({
		clockBuffer: BarrierClock.create(4).buffer,
		post: (message) => messages.push(message),
		jobId: () => "j1",
		skipAckWait: true,
	});
	return { cp: createGatedChildProcess(realChildProcess, client), messages };
}

function collect(child: realChildProcess.ChildProcess): Promise<{ stdout: string; code: number | null }> {
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	return new Promise((resolveClose) => child.once("close", (code) => resolveClose({ stdout, code })));
}

describe.skipIf(process.platform === "win32")("go-line shim semantics", () => {
	it("hands the command the caller's stdin descriptor, not the go-line pipe", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tgs-"));
		const input = join(dir, "input.txt");
		await writeFile(input, "from-the-file\n");
		const handle = await open(input, "r");
		cleanups.push(async () => {
			await handle.close();
			await rm(dir, { recursive: true, force: true });
		});
		const { cp, messages } = gated();
		const child = cp.spawn("cat", [], { stdio: [handle.fd, "pipe", "inherit"] });
		expect(await collect(child)).toEqual({ stdout: "from-the-file\n", code: 0 });
		expect(messages.find((message) => message.kind === "launch")).toMatchObject({
			request: { containment: "own-group" },
		});
	});

	it("emits the ENOENT 'error' an ungated spawn emits for a program it cannot find", async () => {
		const { cp } = gated();
		const child = cp.spawn("senpi-definitely-missing-program", ["x"], { stdio: "ignore" });
		const error = await new Promise<NodeJS.ErrnoException>((resolveError) => child.once("error", resolveError));
		expect(error).toMatchObject({ code: "ENOENT", syscall: "spawn senpi-definitely-missing-program" });
	});

	it("runs a custom shell string with that shell", async () => {
		const { cp } = gated();
		const child = cp.spawn('echo "$0"', [], { shell: "/bin/bash", stdio: ["ignore", "pipe", "inherit"] });
		const { stdout } = await collect(child);
		expect(stdout.trim()).toBe("/bin/bash");
	});
});
