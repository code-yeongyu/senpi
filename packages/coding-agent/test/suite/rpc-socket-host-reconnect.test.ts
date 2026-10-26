import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import type { RecordValue } from "../helpers/rpc-jsonl-peer.ts";
import {
	connectPeer,
	openedSessionId,
	scratch,
	spawnRpc,
	stopChild,
	waitForStderr,
} from "../helpers/rpc-socket-host-support.ts";

function isStatus(record: RecordValue, sessionId: string, cause: "detach"): boolean {
	const change = record.lastChange;
	const changeCause = typeof change === "object" && change !== null && "cause" in change ? change.cause : undefined;
	return record.type === "session_status" && record.sessionId === sessionId && changeCause === cause;
}

describe("RPC Unix-socket multi-connection host", () => {
	it("reopens the path after explicit close and dropped surviving attachment", async () => {
		const qa = scratch("reopen");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		const path = join(qa.sessionDir, "reopen.jsonl");
		try {
			const opened = await a.peer.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath: path,
			});
			const sessionId = openedSessionId(opened);
			await b.peer.request({
				id: "attach",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath: path,
			});
			await a.peer.request({ id: "close", type: "close_session", sessionId });
			// The drop closes the last attachment; the host reports its registry reaching zero sessions.
			const closed = a.peer.waitFor((record) => record.type === "host_trimmed" && record.sessions === 0);
			b.peer.close();
			b.socket.destroy();
			await closed;
			const c = await connectPeer(qa.socketPath);
			try {
				await expect(
					c.peer.request({
						id: "fresh",
						type: "open_session",
						cwd: qa.cwd,
						sessionPath: path,
					}),
				).resolves.toMatchObject({ success: true });
				expect(
					(c.peer.messages.find((value) => value.id === "fresh")?.data as RecordValue | undefined)?.attached ??
						false,
				).toBe(false);
			} finally {
				c.peer.close();
				c.socket.destroy();
			}
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("keeps a co-attached session alive when one of its connections drops", async () => {
		const qa = scratch("drop-survivor");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const sessionPath = join(qa.sessionDir, "shared.jsonl");
		const holder = await connectPeer(qa.socketPath);
		const dropper = await connectPeer(qa.socketPath);
		try {
			const held = await holder.peer.request({
				id: "open-hold",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
			});
			expect(held).toMatchObject({ success: true });
			const heldId = openedSessionId(held);

			const attached = await dropper.peer.request({
				id: "open-attach",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
			});
			expect(attached).toMatchObject({ success: true });
			expect((attached.data as RecordValue | undefined)?.attached).toBe(true);

			// Only the second attachment dies. The runtime is refcounted, so the
			// holder must keep serving commands on its own handle.
			expect(await holder.peer.request({ id: "watch", type: "subscribe_sessions" })).toMatchObject({
				success: true,
			});
			const detached = holder.peer.waitFor((record) => isStatus(record, heldId, "detach"));
			dropper.peer.close();
			dropper.socket.destroy();
			await detached;

			await expect(
				holder.peer.request({
					id: "probe-hold",
					type: "get_protocol_info",
					sessionId: heldId,
				}),
			).resolves.toMatchObject({ success: true });
			await expect(
				holder.peer.request({
					id: "close-hold",
					type: "close_session",
					sessionId: heldId,
				}),
			).resolves.toMatchObject({ success: true });
		} finally {
			holder.peer.close();
			holder.socket.destroy();
			dropper.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});
});
