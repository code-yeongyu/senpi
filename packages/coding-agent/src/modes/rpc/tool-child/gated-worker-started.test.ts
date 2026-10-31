// senpi#3566 todo 4 (Windows half): a job worker's `started` report reaches the gate through startGatedWorker, so the
// server records command_started (Windows CI at 7b07d6008: the worker filter dropped it and no job membership followed).
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolChildChannel } from "./channel.ts";
import { startGatedWorker } from "./gated-worker.ts";
import { LaunchGate } from "./launch-gate.ts";
import type { ToolChildMessage } from "./protocol.ts";

describe("startGatedWorker", () => {
	it("forwards a worker's started report to the gate as command_started", async () => {
		const sent: ToolChildMessage[] = [];
		const channel = {
			send: (message: ToolChildMessage) => {
				sent.push(message);
				return true;
			},
			onMessage: () => () => {},
			closed: new Promise(() => {}),
			close: () => {},
		} satisfies Pick<ToolChildChannel, "send" | "onMessage" | "closed" | "close">;
		const gate = new LaunchGate(channel as ToolChildChannel);
		const worker = startGatedWorker(
			gate,
			new URL(resolve(import.meta.dirname, "../../../../test/fixtures/gated-started-worker.ts"), "file:"),
			"j1",
		);
		const result = await new Promise<{ pid: number }>((resolveResult) =>
			worker.on("message", (message: { kind?: string; pid?: number }) => {
				if (message.kind === "result") resolveResult({ pid: message.pid ?? -1 });
			}),
		);
		await worker.terminate();
		expect(sent.find((message) => message.type === "command_started")).toMatchObject({
			pid: result.pid,
			breakaway: false,
		});
	}, 30_000);
});
