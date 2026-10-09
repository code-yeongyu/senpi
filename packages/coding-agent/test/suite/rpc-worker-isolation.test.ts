import { execFileSync } from "node:child_process";
import { type open, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startWorkerHost, waitForFifoReader } from "./rpc-worker-host-support.ts";

describe("real shared RPC session workers", () => {
	it("serves siblings and rejects aliases while a session reader is blocked", async () => {
		const host = await startWorkerHost();
		const fifo = join(host.scratch, "blocked.jsonl");
		const alias = join(host.scratch, "alias.jsonl");
		execFileSync("mkfifo", [fifo]);
		await symlink(fifo, alias);
		let gate: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const b = await host.request({ type: "open_session", cwd: host.cwd });
			expect(b.success).toBe(true);
			const opening = host.request({ type: "open_session", cwd: host.cwd, sessionPath: fifo });
			// FIFO writer-open is the exact signal that the real session reader entered open(2).
			gate = await waitForFifoReader(fifo);
			try {
				const list = await host.request({ type: "list_sessions" }, 3000);
				expect(list.success).toBe(true);
				const state = await host.request({ type: "get_state", sessionId: b.data?.sessionId }, 3000);
				expect(state.success).toBe(true);
				expect(state.data?.sessionId).toBe(b.data?.state?.sessionId);
				const duplicate = await host.request({ type: "open_session", cwd: host.cwd, sessionPath: alias });
				expect(duplicate.error).toBe("session_path_in_use");
				const sibling = await host.request({ type: "open_session", cwd: host.cwd });
				expect(sibling.success).toBe(true);
			} finally {
				const header = `${JSON.stringify({ type: "session", version: 3, id: "fifo-durable", timestamp: new Date(0).toISOString(), cwd: host.cwd })}\n`;
				await unlink(fifo);
				await writeFile(fifo, header);
				await gate.write(header);
				await gate.close();
				gate = undefined;
			}
			expect((await opening).success).toBe(true);
		} finally {
			await gate?.close();
			await host.dispose();
		}
	}, 60_000);

	it("closes a spinning JavaScript worker without terminating its sibling", async () => {
		const host = await startWorkerHost(`export default function (pi) {
			pi.registerCommand("spin", { description: "test CPU gate", handler: async (_args, ctx) => {
				ctx.ui.notify("CPU_GATE_ENTERED", "info");
				for (;;) {}
			} });
		}`);
		try {
			const a = await host.request({ type: "open_session", cwd: host.cwd });
			const b = await host.request({ type: "open_session", cwd: host.cwd });
			expect(a.success).toBe(true);
			expect(b.success).toBe(true);
			const entered = host.wait((record) => record.message === "CPU_GATE_ENTERED");
			const spinning = host.request({ type: "prompt", sessionId: a.data?.sessionId, message: "/spin" });
			await entered;
			const state = await host.request({ type: "get_state", sessionId: b.data?.sessionId }, 3000);
			expect(state.data?.sessionId).toBe(b.data?.state?.sessionId);
			const close = await host.request({ type: "close_session", sessionId: a.data?.sessionId }, 3000);
			expect(close.success).toBe(true);
			await spinning;
			const after = await host.request({ type: "get_state", sessionId: b.data?.sessionId }, 3000);
			expect(after.success).toBe(true);
			expect(after.data?.sessionId).toBe(b.data?.state?.sessionId);
		} finally {
			await host.dispose();
		}
	}, 60_000);

	it("attaches aliases to one runtime and keeps it alive after one attachment closes", async () => {
		const host = await startWorkerHost();
		const path = join(host.scratch, "session.jsonl");
		const alias = join(host.scratch, "alias.jsonl");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "attached-durable", timestamp: new Date(0).toISOString(), cwd: host.cwd })}\n`,
		);
		await symlink(path, alias);
		try {
			const a = await host.request({ type: "open_session", cwd: host.cwd, sessionPath: path });
			const b = await host.request({ type: "open_session", cwd: host.cwd, sessionPath: alias });
			expect(a.success).toBe(true);
			expect(b.success).toBe(true);
			expect(b.data?.attached).toBe(true);
			expect(b.data?.sessionId).toBe(a.data?.sessionId);
			await host.request({ type: "close_session", sessionId: a.data?.sessionId });
			const state = await host.request({ type: "get_state", sessionId: b.data?.sessionId });
			expect(state.success).toBe(true);
			expect(state.data?.sessionId).toBe("attached-durable");
		} finally {
			await host.dispose();
		}
	}, 60_000);
});
