import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../../src/kernels/sandbox/vendor/pi-codemode/runtime/host.ts";
import type { CodemodeOutputFrame } from "../../src/kernels/sandbox/vendor/pi-codemode/types.ts";

const sandboxes: CodemodeSandbox[] = [];

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map(async (sandbox) => await sandbox.close()));
});

function streamingSandbox(onFrame: (frame: CodemodeOutputFrame) => void | Promise<void>, windowBytes?: number) {
	const sandbox = new CodemodeSandbox({
		output: "stream",
		onOutputFrame: onFrame,
		...(windowBytes === undefined ? {} : { windowBytes }),
		timeoutMs: 60_000,
	});
	sandboxes.push(sandbox);
	return sandbox;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

describe("Given a sandbox in output stream mode", () => {
	it("When a script prints one 20 MiB text item, then it arrives complete in frames of at most 64 KiB and never more than the window in flight", async () => {
		const parts: string[] = [];
		let largestFrame = 0;
		const sandbox = streamingSandbox((frame) => {
			largestFrame = Math.max(largestFrame, frame.chunk.length * 2);
			parts.push(frame.chunk);
		});
		const size = 20 * 1024 * 1024;

		const result = await sandbox.execute(`text("x".repeat(${size})); return "done"`);

		expect(result).toMatchObject({ ok: true, value: "done", output: [] });
		expect(sha256(parts.join(""))).toBe(sha256("x".repeat(size)));
		expect(largestFrame).toBeLessThanOrEqual(64 * 1024);
		expect(result.streamed?.maxInFlightBytes).toBeLessThanOrEqual(256 * 1024);
		expect(result.streamed?.frames).toBe(parts.length);
	}, 120_000);

	it("When a script prints 20 MiB as many small items, then every item arrives in order and the window still bounds what is in flight", async () => {
		const items = new Map<number, string[]>();
		const sandbox = streamingSandbox((frame) => {
			const item = items.get(frame.itemId) ?? [];
			item.push(frame.chunk);
			items.set(frame.itemId, item);
		});

		const result = await sandbox.execute('for (let i = 0; i < 20480; i++) text(String(i).padEnd(512, "."));');

		expect(result.ok).toBe(true);
		expect(items.size).toBe(20480);
		expect(items.get(12345)?.join("")).toBe("12345".padEnd(512, "."));
		expect(result.streamed?.maxInFlightBytes).toBeLessThanOrEqual(256 * 1024);
	}, 120_000);

	it("When the consumer is slow, then the worker waits for credit instead of running ahead of it", async () => {
		let consumed = 0;
		let active = 0;
		let maxActive = 0;
		const sandbox = streamingSandbox(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			consumed++;
			await new Promise<void>((resolve) => setImmediate(resolve));
			active--;
		}, 4 * 1024);

		const result = await sandbox.execute('for (let i = 0; i < 64; i++) text("y".repeat(1024));');

		expect(result.ok).toBe(true);
		expect(consumed).toBe(64);
		expect(maxActive).toBe(1);
		expect(result.streamed?.maxInFlightBytes).toBeLessThanOrEqual(4 * 1024);
	}, 60_000);

	it("When an image is printed, then its base64 data arrives complete with its mime type on every frame", async () => {
		const frames: CodemodeOutputFrame[] = [];
		const sandbox = streamingSandbox((frame) => {
			frames.push(frame);
		});
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(300 * 1024, 7),
		]);
		const data = png.toString("base64");

		const result = await sandbox.execute(`image("data:image/png;base64,${data}")`);

		expect(result.ok).toBe(true);
		expect(frames.every((frame) => frame.type === "image" && frame.mimeType === "image/png")).toBe(true);
		expect(frames.map((frame) => frame.chunk).join("")).toBe(data);
		expect(frames.at(-1)?.final).toBe(true);
	}, 60_000);

	it("When the run is aborted while the worker waits for credit, then it settles as aborted and the worker does not hang", async () => {
		const controller = new AbortController();
		const blocked = Promise.withResolvers<void>();
		const sandbox = streamingSandbox(async () => {
			blocked.resolve();
			await new Promise<void>(() => {});
		}, 1024);

		const pending = sandbox.execute('for (;;) text("z".repeat(512));', { signal: controller.signal });
		await blocked.promise;
		controller.abort(new Error("stop"));

		await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: "aborted" } });
	}, 30_000);
});

describe("Given a streaming run whose consumer never returns", () => {
	function stuckSandbox(timeoutMs = 60_000) {
		const sandbox = new CodemodeSandbox({
			output: "stream",
			onOutputFrame: () => new Promise<void>(() => undefined),
			timeoutMs,
		});
		sandboxes.push(sandbox);
		return sandbox;
	}

	function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
		return Promise.race([
			promise,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms).unref()),
		]);
	}

	it("When the script finishes and the run is aborted afterwards, then it settles as aborted instead of waiting on the consumer", async () => {
		const controller = new AbortController();
		const run = stuckSandbox().execute('text("a"); return 1', { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 300));

		controller.abort();

		await expect(settledWithin(run, 3_000)).resolves.toMatchObject({ ok: false, error: { kind: "aborted" } });
	}, 15_000);

	it("When the script finishes and the timeout passes while frames drain, then it settles as timed out", async () => {
		const run = stuckSandbox(800).execute('text("a"); return 1');

		await expect(settledWithin(run, 5_000)).resolves.toMatchObject({ ok: false, error: { kind: "timeout" } });
	}, 15_000);

	it("When the sandbox is closed while frames drain, then the run settles", async () => {
		const sandbox = stuckSandbox();
		const run = sandbox.execute('text("a"); return 1');
		await new Promise((resolve) => setTimeout(resolve, 300));

		await sandbox.close();

		await expect(settledWithin(run, 3_000)).resolves.toMatchObject({ ok: false, error: { kind: "aborted" } });
	}, 15_000);
});

describe("Given a streaming run aborted with frames still queued", () => {
	it("When it settles, then the consumer is handed no frame afterwards", async () => {
		let release = (): void => undefined;
		let settled = false;
		let afterSettle = 0;
		let first = true;
		const sandbox = new CodemodeSandbox({
			output: "stream",
			frameBytes: 16,
			windowBytes: 4096,
			onOutputFrame: async () => {
				if (settled) afterSettle++;
				if (first) {
					first = false;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
			},
			timeoutMs: 60_000,
		});
		sandboxes.push(sandbox);
		const controller = new AbortController();
		const run = sandbox.execute('for (let i = 0; i < 50; i++) text("0123456789abcdef");', {
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));

		controller.abort();
		const result = await run;
		settled = true;
		release();
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(result).toMatchObject({ ok: false, error: { kind: "aborted" } });
		expect(afterSettle).toBe(0);
	}, 15_000);
});

describe("Given stream options too small to hold a surrogate pair", () => {
	it.each([[2], [3]])("When frameBytes is %i, then the sandbox refuses it", (frameBytes) => {
		expect(() => new CodemodeSandbox({ output: "stream", onOutputFrame: () => undefined, frameBytes })).toThrow(
			"must be at least 4",
		);
	});

	it("When frameBytes is 4, then a two-emoji text arrives with no lone surrogate in any frame", async () => {
		const frames: string[] = [];
		const sandbox = new CodemodeSandbox({
			output: "stream",
			onOutputFrame: (frame) => void frames.push(frame.chunk),
			frameBytes: 4,
			timeoutMs: 30_000,
		});
		sandboxes.push(sandbox);

		await sandbox.execute('text("\u{1F600}\u{1F601}")');

		expect(frames.join("")).toBe("\u{1F600}\u{1F601}");
		expect(frames.every((chunk) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(chunk))).toBe(true);
	}, 30_000);
});

describe("Given a sandbox with the store builtin rejected", () => {
	it("When a script calls store and load, then store throws CodemodeStoreDisabledError and load finds nothing", async () => {
		const sandbox = new CodemodeSandbox({ builtins: { store: "reject" } });
		sandboxes.push(sandbox);

		const loaded = await sandbox.execute('return load("k")', { store: { k: 1 } });
		const stored = await sandbox.execute('store("k", 2)');

		expect(loaded).toMatchObject({ ok: true, value: undefined });
		expect(stored).toMatchObject({ ok: false, error: { kind: "script", name: "CodemodeStoreDisabledError" } });
	}, 30_000);
});

describe("Given a sandbox with default options", () => {
	it("When a script prints and stores, then output is collected and store works as upstream", async () => {
		const sandbox = new CodemodeSandbox();
		sandboxes.push(sandbox);

		const result = await sandbox.execute('text("a"); store("k", 3); return load("k")');

		expect(result).toMatchObject({
			ok: true,
			value: 3,
			output: [{ type: "text", text: "a" }],
			storeWrites: { set: { k: 3 } },
		});
		expect(result.streamed).toBeUndefined();
	}, 30_000);
});
