import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcess[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	}
});

function start(runtime: string, args: string[] = [], env: Readonly<Record<string, string>> = {}) {
	const child = spawn(
		runtime,
		[
			...(runtime === "bun" ? [] : ["--import", "tsx"]),
			join(import.meta.dirname, "rpc-internal-bootstrap-harness.ts"),
			...args,
		],
		{
			env: { ...process.env, ...env, SENPI_RPC_INTERNAL_KEY_STDIN: "1" },
			stdio: ["pipe", "ignore", "pipe", "pipe", "ipc"],
		},
	);
	children.push(child);
	let stderr = "";
	child.stderr?.on("data", (data) => {
		stderr += String(data);
	});
	return { child, stderr: () => stderr };
}

function message(child: ChildProcess): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const received = (value: unknown) => {
			cleanup();
			resolve(value);
		};
		const exited = (code: number | null) => {
			cleanup();
			reject(new Error(`bootstrap exited ${code} before reporting`));
		};
		const cleanup = () => {
			child.off("message", received);
			child.off("exit", exited);
		};
		child.once("message", received);
		child.once("exit", exited);
	});
}

// senpi#3795: real socketpair stdin, on both runtimes; no inherited agent profile.
describe.skipIf(process.platform === "win32")("internal stdin bootstrap", () => {
	for (const runtime of ["node", "bun"]) {
		it(`${runtime} restores null stdin and its inherited-stdin descendant completes while the writer lives`, async () => {
			const { child, stderr } = start(runtime);
			const ready = message(child);
			child.stdin?.write(Buffer.alloc(32, 7));
			const result = await ready;
			expect(result).toMatchObject({ type: "ready", key: "07".repeat(32), stdinNull: true, catCode: 0 });
			expect(result).toHaveProperty("lifetime", process.platform === "darwin");
			if (process.platform === "linux") expect(stderr()).toContain("identity poll");
			const exit = once(child, "exit");
			child.send("exit");
			expect((await exit)[0]).toBe(0);
		});

		it.skipIf(process.platform !== "darwin")(`${runtime} delivers reopened-stdin EOF`, async () => {
			const { child } = start(runtime);
			const ready = message(child);
			child.stdin?.write(Buffer.alloc(32, 7));
			await ready;
			const eof = message(child);
			const exit = once(child, "exit");
			child.stdin?.end();
			expect(await eof).toEqual({ type: "eof" });
			expect((await exit)[0]).toBe(0);
		});

		it.each(["ENXIO", "ENOENT", "EACCES"])(`${runtime} restores stdin after reopen failure %s`, async (errno) => {
			const { child, stderr } = start(runtime, ["fail-reopen", errno]);
			const ready = message(child);
			child.stdin?.write(Buffer.alloc(32, 7));
			expect(await ready).toMatchObject({ stdinNull: true, catCode: 0, lifetime: false });
			expect(stderr()).toContain("identity poll");
		});

		// senpi#4528: the deadline worker exits once released, and its exit writes compile-cache entries under
		// NODE_COMPILE_CACHE. Released before the fd 0 restore, one of those opens could take the free fd 0 and the host
		// refused to start ("cannot restore stdin"). Bun has no NODE_COMPILE_CACHE flush to observe.
		it.skipIf(runtime !== "node")(`${runtime} keeps the deadline worker parked while fd 0 is free`, async () => {
			const cache = mkdtempSync(join(tmpdir(), "senpi-bootstrap-cache-"));
			try {
				const { child } = start(runtime, ["await-worker-io"], { NODE_COMPILE_CACHE: cache });
				const ready = message(child);
				child.stdin?.write(Buffer.alloc(32, 7));
				expect(await ready).toMatchObject({ type: "ready", stdinNull: true, workerIoWhileStdinFree: false });
				const exit = once(child, "exit");
				child.send("exit");
				expect((await exit)[0]).toBe(0);
			} finally {
				rmSync(cache, { recursive: true, force: true });
			}
		});

		it(`${runtime} refuses a missing key`, async () => {
			const { child, stderr } = start(runtime);
			const exit = once(child, "exit");
			child.stdin?.end();
			expect((await exit)[0]).not.toBe(0);
			expect(stderr()).toContain("internal_key_unavailable");
		});

		it(`${runtime} bounds a missing key even while the writer stays open`, async () => {
			const { child, stderr } = start(runtime);
			const exit = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
			expect((await exit)[0]).not.toBe(0);
			expect(stderr()).toContain("internal_key_unavailable");
		});
	}
});
