/**
 * senpi#6752 review L3, L4: the handler's own failure edges. A machine state dir that cannot be made answers that
 * line with a typed refusal and is tried again on the next op (never a cached rejection); a kill whose process
 * outlives the manager's stop answers after a bounded wait instead of hanging.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MachineOpHandler } from "../../src/modes/rpc/machine-op/handler.ts";
import type { LiveHandle } from "../../src/modes/rpc/machine-op/live-handle.ts";
import { MachineTerminals } from "../../src/modes/rpc/machine-op/machine-terminals.ts";

describe("senpi#6752 review: machine_op handler failure edges", () => {
	it("answers machine_op_unavailable when the machine state dir cannot be made, and makes it on the next op", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "mop-l3-"));
		const blocker = join(agentDir, "machine");
		await writeFile(blocker, "a file where the machine state dir goes");
		const handler = new MachineOpHandler({ agentDir });
		const record = {
			type: "machine_op",
			op: "shell",
			args: { command: "printf ok" },
			op_id: "op-l3",
			scope: { root: agentDir, confined: false },
			sender: "device-l3",
		};
		try {
			expect(await handler.answer("machine_op", record, "a1")).toEqual({
				id: "a1",
				type: "response",
				command: "machine_op",
				success: false,
				error: expect.stringMatching(/^machine_op_unavailable: /),
				errorCode: "machine_op_unavailable",
			});
			await rm(blocker);
			expect(await handler.answer("machine_op", record, "a2")).toMatchObject({
				success: true,
				data: { state: "applied", response: { stdout: "ok" } },
			});
		} finally {
			await handler.dispose();
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("answers a kill whose process outlives the stop after a bounded wait", async () => {
		vi.useFakeTimers();
		try {
			const terminals = new MachineTerminals((ms, fn) => {
				const timer = setTimeout(fn, ms);
				return () => clearTimeout(timer);
			});
			const stuck = {
				id: "h-stuck",
				exit: () => null,
				markKilled: () => {},
				ended: new Promise<void>(() => {}),
			} as unknown as LiveHandle;
			let settled = false;
			const killing = terminals.kill(stuck).then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(4_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await killing;
			expect(settled).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
