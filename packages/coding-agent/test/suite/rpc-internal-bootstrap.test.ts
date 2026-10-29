import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
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

// senpi#4737: reject at exit even if a descendant holds stderr; retain late output when close follows.
function message(child: ChildProcess, stderr: () => string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const received = (value: unknown) => {
			cleanup();
			resolve(value);
		};
		const exited = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			const reason = `bootstrap exited ${code} (signal ${signal ?? "none"}) before reporting`;
			const error = new Error(`${reason}\n${stderr() || "(no stderr)"}`);
			child.once("close", () => {
				error.message = `${reason}\n${stderr() || "(no stderr)"}`;
			});
			reject(error);
		};
		const failed = (cause: Error) => {
			cleanup();
			reject(new Error(`bootstrap failed to spawn before reporting\n${stderr() || "(no stderr)"}`, { cause }));
		};
		const cleanup = () => {
			child.off("message", received);
			child.off("exit", exited);
			child.off("error", failed);
		};
		child.once("message", received);
		child.once("exit", exited);
		child.once("error", failed);
	});
}

// senpi#3795: real socketpair stdin, on both runtimes; no inherited agent profile.
describe.skipIf(process.platform === "win32")("internal stdin bootstrap", () => {
	// senpi#4737: a descendant owns stderr until explicitly released, independently of its parent's exit.
	it("rejects on exit while a descendant holds stderr open", async () => {
		const holder = `
			const { Socket } = require("node:net");
			const { writeSync } = require("node:fs");
			const control = new Socket({ fd: 3, readable: true, writable: false });
			control.once("data", () => {
				writeSync(2, "after-exit");
				process.exit(0);
			});
			control.once("end", () => process.exit(0));
			control.resume();
			writeSync(2, "before-exit");
			process.send("ready");
		`;
		const child = spawn(
			"node",
			[
				"-e",
				`
			const { spawn } = require("node:child_process");
			const holder = spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], {
				stdio: ["ignore", "ignore", "inherit", 3, "ipc"],
			});
			holder.once("message", () => process.send("ready"));
			process.once("message", () => process.exit(7));
		`,
			],
			{ stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"] },
		);
		children.push(child);
		const control = child.stdio[3] as Duplex;
		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += String(data);
		});
		const firstStderr = once(child.stderr!, "data");
		let closed = false;
		const close = once(child, "close").then(() => {
			closed = true;
		});
		try {
			await once(child, "message");
			await firstStderr;
			let failure: Error | undefined;
			const report = message(child, () => stderr).catch((cause: Error) => {
				failure = cause;
			});
			const exit = once(child, "exit");
			child.send("exit");
			await exit;
			try {
				// message's exit listener precedes ours, so its rejection handler has already run.
				expect(failure).toBeInstanceOf(Error);
				expect(failure?.message).toContain("before-exit");
				expect(closed).toBe(false);
			} finally {
				control.end("release");
				await close;
				await report;
			}
			expect(failure?.message).toContain("after-exit");
		} finally {
			control.destroy();
		}
	});

	for (const runtime of ["node", "bun"]) {
		it(`${runtime} restores null stdin and its inherited-stdin descendant completes while the writer lives`, async () => {
			const { child, stderr } = start(runtime);
			const ready = message(child, stderr);
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
			const { child, stderr } = start(runtime);
			const ready = message(child, stderr);
			child.stdin?.write(Buffer.alloc(32, 7));
			await ready;
			const eof = message(child, stderr);
			const exit = once(child, "exit");
			child.stdin?.end();
			expect(await eof).toEqual({ type: "eof" });
			expect((await exit)[0]).toBe(0);
		});

		it.each(["ENXIO", "ENOENT", "EACCES"])(`${runtime} restores stdin after reopen failure %s`, async (errno) => {
			const { child, stderr } = start(runtime, ["fail-reopen", errno]);
			const ready = message(child, stderr);
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
				const { child, stderr } = start(runtime, ["await-worker-io"], { NODE_COMPILE_CACHE: cache });
				const ready = message(child, stderr);
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
