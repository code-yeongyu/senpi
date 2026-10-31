// senpi#3566 todo 9: a child job streams partial results to the server in order, paced by acknowledgement (at most
// TOOL_CHILD_LIMITS.updatesInFlight unacknowledged), large ones by reference, and its result settles after every update.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ToolChildClient } from "./client.ts";
import { JobUpdates } from "./job-updates.ts";
import { PayloadRefWriter } from "./payload-ref.ts";
import { TOOL_CHILD_LIMITS } from "./protocol.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const fixture = resolve(import.meta.dirname, "../../../../test/fixtures/tool-child-fixture.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function started(): Promise<ToolChildClient> {
	const root = await mkdtemp(join(tmpdir(), "tju-"));
	const instance = new ToolChildClient({
		dir: join(root, "ch"),
		cwd: root,
		env: { ...process.env, TOOL_CHILD_FIXTURE_MODE: "serve" },
		command: { command: process.execPath, args: ["--import", resolver, fixture] },
	});
	cleanups.push(async () => {
		await instance.close();
		await rm(root, { recursive: true, force: true });
	});
	await instance.start();
	return instance;
}

describe.skipIf(process.platform === "win32")("streamed job updates", () => {
	it("delivers every update in order, never more than the window unacknowledged, and the result after them", async () => {
		const instance = await started();
		const seen: unknown[] = [];
		let resultAt = -1;
		const bigBytes = TOOL_CHILD_LIMITS.REF_THRESHOLD + 1024;
		const result = await instance
			.run("stream", { count: 200, bigBytes }, undefined, { onUpdate: (value) => seen.push(value) })
			.then((value) => {
				resultAt = seen.length;
				return value;
			});
		expect(result).toEqual({ sent: 201 });
		expect(resultAt).toBe(201);
		expect(seen.slice(0, 200)).toEqual(Array.from({ length: 200 }, (_unused, index) => ({ index: index + 1 })));
		expect(String(Reflect.get(Object(seen[200]), "big")).length).toBe(bigBytes);
	}, 60_000);

	it("paces a producer at the window: exactly the window goes out unacknowledged, each ack frees one", async () => {
		const sent: number[] = [];
		const stream = new JobUpdates({
			jobId: "j1",
			channel: { send: (frame) => (frame.type === "update" ? sent.push(frame.seq) > 0 : true) },
			window: 4,
		});
		const producing = (async () => {
			for (let index = 0; index < 10; index++) await stream.update(index);
		})();
		await settledTurns();
		expect(sent).toEqual([1, 2, 3, 4]);
		stream.acked(2);
		await settledTurns();
		expect(sent).toEqual([1, 2, 3, 4, 5, 6]);
		stream.acked(10);
		await producing;
		expect(sent).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("sends unawaited updates in call order with consecutive seqs, a large one packed first included", async () => {
		const root = await mkdtemp(join(tmpdir(), "tju-order-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const frames: Array<{ seq: number; byRef: boolean }> = [];
		const stream = new JobUpdates({
			jobId: "j1",
			channel: {
				send: (frame) =>
					frame.type === "update"
						? frames.push({ seq: frame.seq, byRef: frame.valueRef !== undefined }) > 0
						: true,
			},
			writer: new PayloadRefWriter({ root, generation: 1 }),
		});
		const big = stream.update({ big: "x".repeat(TOOL_CHILD_LIMITS.REF_THRESHOLD + 1024) });
		const small = stream.update({ small: true });
		await Promise.all([big, small]);
		expect(frames).toEqual([
			{ seq: 1, byRef: true },
			{ seq: 2, byRef: false },
		]);
	});

	it("releases a producer waiting for credit when its job ends, with an error rather than a hang", async () => {
		const stream = new JobUpdates({ jobId: "j1", channel: { send: () => true }, window: 1 });
		await stream.update("first");
		const blocked = stream.update("second");
		stream.end();
		await expect(blocked).rejects.toThrow("update after job j1 ended");
	});
});

/** Lets every already-queued promise continuation run (the producer's sends are microtask-chained). */
async function settledTurns(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}
