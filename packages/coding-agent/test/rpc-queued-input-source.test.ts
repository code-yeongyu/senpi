import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpcConnectionHandler } from "../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "./suite/rpc-connection-harness.ts";

/**
 * Queued input (steer / follow_up) sent over RPC must reach the session with its
 * real input source, so `input` extension handlers see "rpc" instead of the
 * interactive default. The RPC host also owns the client-supplied enqueue order;
 * adding the source must not drop it.
 */
describe("RPC queued input source", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `rpc-input-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		cleanup = () => {};
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('steers with source "rpc" and the client enqueue order', async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const steer = vi.spyOn(harness.runtimeHost.session, "steer").mockResolvedValue(undefined);
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(
			JSON.stringify({ id: "steer-1", type: "steer", message: "turn left", enqueueOrder: 7 }),
		);

		expect(await collected.waitFor((message) => message.id === "steer-1")).toMatchObject({
			type: "response",
			command: "steer",
			success: true,
		});
		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer.mock.calls[0]?.[0]).toBe("turn left");
		expect(steer.mock.calls[0]?.[2]).toMatchObject({ source: "rpc", enqueueOrder: 7 });

		await handler.dispose();
	});

	it('follows up with source "rpc" and the client enqueue order', async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const followUp = vi.spyOn(harness.runtimeHost.session, "followUp").mockResolvedValue(undefined);
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(
			JSON.stringify({ id: "follow-1", type: "follow_up", message: "then stop", enqueueOrder: 9 }),
		);

		expect(await collected.waitFor((message) => message.id === "follow-1")).toMatchObject({
			type: "response",
			command: "follow_up",
			success: true,
		});
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]?.[0]).toBe("then stop");
		expect(followUp.mock.calls[0]?.[2]).toMatchObject({ source: "rpc", enqueueOrder: 9 });

		await handler.dispose();
	});
});
