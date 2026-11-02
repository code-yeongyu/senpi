// senpi#3566 todo 7: the reverse bridge against a real tool child - a module job calls the server through `host.call`,
// and both sides hold the shared capacity (8 running, 256 queued, the next one refused with a correlated error).
import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ToolChildClient } from "../src/modes/rpc/tool-child/client.ts";
import type { HostCallHandler } from "../src/modes/rpc/tool-child/host-calls-server.ts";
import { TOOL_CHILD_MODULE_ROOTS_ENV } from "../src/modes/rpc/tool-child/module-job.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../src/experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../src/tool-child-main.ts");
const extensionDir = resolve(import.meta.dirname, "fixtures/module-job-ext");
const modulePath = join(extensionDir, "offload.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startChild(onHostCall: HostCallHandler, onDir: (dir: string) => void = () => {}) {
	const dir = await mkdtemp(join(tmpdir(), "trb-"));
	onDir(dir);
	const instance = new ToolChildClient({
		dir,
		cwd: dir,
		command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
		env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify([extensionDir]) },
		onHostCall,
	});
	cleanups.push(async () => {
		await instance.close();
		await rm(dir, { recursive: true, force: true });
	});
	await instance.start();
	return instance;
}

/** Holds calls and releases them 8 at a time (or the remainder); records the most ever running at once. */
function batchingHandler(total: number, ready: Promise<void> = Promise.resolve()) {
	const held: Array<() => void> = [];
	let received = 0;
	let running = 0;
	let maxRunning = 0;
	const handler: HostCallHandler = async () => {
		await ready;
		return new Promise((resolveCall) => {
			received += 1;
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			held.push(() => {
				running -= 1;
				resolveCall({ ok: true });
			});
			if (held.length === 8 || received === total) for (const release of held.splice(0)) release();
		});
	};
	return { handler, stats: () => ({ received, maxRunning }) };
}

/** Resolves once no payload file is left in any `<root>/<generation>/refs/`, watching the root (bounded). */
async function refsEmpty(root: string, timeoutMs: number): Promise<void> {
	const files = async () => {
		const generations = await readdir(root).catch(() => []);
		const counts = await Promise.all(
			generations.map((generation) => readdir(join(root, generation, "refs")).catch(() => [])),
		);
		return counts.flat();
	};
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const left = await files();
		if (left.length === 0) return;
		if (Date.now() > deadline) throw new Error(`refs left after cancel: ${left.join(", ")}`);
		await new Promise<void>((resolveChange) => {
			const watcher = watch(root, { recursive: true }, () => {
				watcher.close();
				resolveChange();
			});
			setTimeout(
				() => {
					watcher.close();
					resolveChange();
				},
				Math.max(0, deadline - Date.now()),
			);
		});
	}
}

describe("reverse bridge", () => {
	it("answers a module job's host call with the server's value, naming the calling job", async () => {
		const instance = await startChild(async (request) => ({
			kind: request.kind,
			name: request.name,
			args: request.args,
			jobId: request.jobId,
		}));
		const value = await instance.run("module", {
			modulePath,
			export: "askHost",
			args: { tool: "echo", payload: { x: 1 } },
		});
		expect(value).toMatchObject({ kind: "tool", name: "echo", args: { x: 1 } });
		expect(String(Reflect.get(Object(value), "jobId"))).toMatch(/^j\d+$/);
	}, 60_000);

	it("runs 264 concurrent calls 8 at a time with 256 queued: none refused, all complete", async () => {
		const batching = batchingHandler(264);
		const instance = await startChild(batching.handler);
		expect(await instance.run("module", { modulePath, export: "fanOut", args: { n: 264 } })).toEqual({
			ok: 264,
			failed: [],
		});
		expect(batching.stats()).toEqual({ received: 264, maxRunning: 8 });
	}, 60_000);

	it("refuses exactly the 265th call with a correlated host_call_capacity and loses none of the rest", async () => {
		let refused!: () => void;
		const capacityRefused = new Promise<void>((resolveRefused) => {
			refused = resolveRefused;
		});
		// Do not free a slot until the worker observes the refusal: worker messages can arrive across turns.
		const batching = batchingHandler(264, capacityRefused);
		const instance = await startChild(batching.handler);
		const marker = join(instance.dir, "capacity-refused");
		const watcher = watch(instance.dir, () => {
			if (!existsSync(marker)) return;
			watcher.close();
			refused();
		});
		cleanups.push(async () => watcher.close());
		expect(
			await instance.run("module", {
				modulePath: join(extensionDir, "capacity-fanout.ts"),
				export: "fanOut",
				args: { marker },
			}),
		).toEqual({
			ok: 264,
			failed: [{ index: 264, code: "host_call_capacity", message: expect.stringContaining("h265 refused") }],
		});
		expect(batching.stats()).toEqual({ received: 264, maxRunning: 8 });
	}, 60_000);

	it("carries 17 MiB of arguments by an acknowledged ref the server owns, deleted once the call settles", async () => {
		let dir = "";
		const instance = await startChild(
			async (request) => {
				const payload = String(Reflect.get(Object(request.args), "payload"));
				return { received: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
			},
			(created) => {
				dir = created;
			},
		);
		const bytes = 17 * 1024 * 1024;
		const value = (await instance.run("module", { modulePath, export: "sinkLarge", args: { bytes } })) as {
			reply: { received: number; sha256: string };
			sent: string;
		};
		expect(value.reply.received).toBe(bytes);
		expect(value.reply.sha256).toBe(value.sent);
		expect(await readdir(join(dir, "refs", "1")).catch(() => [])).toEqual([]);
	}, 120_000);

	it("carries a 20 MiB reply by an acknowledged ref the child owns, deleted once delivered", async () => {
		let dir = "";
		const instance = await startChild(
			async (request) => "b".repeat(Number(Reflect.get(Object(request.args), "bytes"))),
			(created) => {
				dir = created;
			},
		);
		const bytes = 20 * 1024 * 1024;
		expect(await instance.run("module", { modulePath, export: "blobLarge", args: { bytes } })).toEqual({
			length: bytes,
		});
		expect(await readdir(join(dir, "refs", "1")).catch(() => [])).toEqual([]);
	}, 120_000);

	it("rejects a cancelled job's outstanding calls and leaves no ref behind, sent or queued", async () => {
		let dir = "";
		const aborted: string[] = [];
		let running = 0;
		let allRunning!: () => void;
		const eightRunning = new Promise<void>((resolveRunning) => {
			allRunning = resolveRunning;
		});
		const instance = await startChild(
			(request) =>
				new Promise((_resolve, reject) => {
					running += 1;
					if (running === 8) allRunning();
					request.signal.addEventListener(
						"abort",
						() => {
							aborted.push(request.callId);
							reject(new Error("cancelled"));
						},
						{ once: true },
					);
				}),
			(childDir) => {
				dir = childDir;
			},
		);
		const cancel = new AbortController();
		const run = instance.run(
			"module",
			{ modulePath, export: "sinkMany", args: { bytes: 2 * 1024 * 1024, n: 12 } },
			cancel.signal,
		);
		await eightRunning;
		cancel.abort();
		await expect(run).rejects.toMatchObject({ code: "tool_child_cancelled" });
		expect(aborted).toHaveLength(8);
		await refsEmpty(join(dir, "refs"), 10_000);
	}, 60_000);

	it("carries a job's 17 MiB arguments by a server-written ref the child owns, deleted once read", async () => {
		let dir = "";
		const instance = await startChild(
			() => Promise.reject(new Error("no host calls")),
			(childDir) => {
				dir = childDir;
			},
		);
		const payload = "j".repeat(17 * 1024 * 1024);
		expect(await instance.run("module", { modulePath, export: "digestArgs", args: { payload } })).toEqual({
			sha256: createHash("sha256").update(payload).digest("hex"),
			bytes: payload.length,
		});
		await refsEmpty(join(dir, "refs"), 10_000);
	}, 60_000);
});
