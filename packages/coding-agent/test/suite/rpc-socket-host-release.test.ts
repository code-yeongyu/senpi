import { existsSync } from "node:fs";
import { watch } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { reservationFile } from "../../src/modes/rpc/host-reservations.ts";
import { canonicalSessionPath } from "../../src/modes/rpc/session-path-key.ts";
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

describe("RPC Unix-socket multi-connection host", () => {
	it("releases a dropped connection's session so the same path reopens fresh", async () => {
		const qa = scratch("drop-release");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const sessionPath = join(qa.sessionDir, "dropped.jsonl");
		const first = await connectPeer(qa.socketPath);
		try {
			const opened = await first.peer.request({
				id: "open-1",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
			});
			expect(opened).toMatchObject({ success: true });
			expect((opened.data as RecordValue | undefined)?.attached ?? false).toBe(false);

			// Ungraceful drop: the terminal closed / the client was SIGKILLed, so no
			// close_session ever arrives. The host must still release what this
			// connection held, otherwise the path stays reserved by a runtime whose
			// client is gone and every later resume of it is wrong.
			const paths = createHostDaemonPaths({ socket: qa.socketPath, agentDir: qa.agentDir });
			const claim = reservationFile(paths.reservationsDir, canonicalSessionPath(sessionPath));
			expect(existsSync(claim)).toBe(true);
			const released = (async () => {
				for await (const event of watch(dirname(claim), { signal: AbortSignal.timeout(15_000) })) {
					if (event.filename === basename(claim) && !existsSync(claim)) return;
				}
				throw new Error("Reservation watcher ended before release");
			})();
			first.peer.close();
			first.socket.destroy();
			await released;
		} finally {
			first.socket.destroy();
		}

		const second = await connectPeer(qa.socketPath);
		try {
			const reopened = await second.peer.request({
				id: "open-2",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
			});
			expect(reopened).toMatchObject({ success: true });
			// A fresh open, NOT an attach to the orphaned runtime.
			expect((reopened.data as RecordValue | undefined)?.attached ?? false).toBe(false);
			await expect(
				second.peer.request({
					id: "close-2",
					type: "close_session",
					sessionId: openedSessionId(reopened),
				}),
			).resolves.toMatchObject({ success: true });
		} finally {
			second.peer.close();
			second.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("keeps the surviving attachment bound after the other explicitly closes", async () => {
		const qa = scratch("att");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		try {
			const opened = await a.peer.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath: join(qa.sessionDir, "att.jsonl"),
			});
			const sessionId = openedSessionId(opened);
			await expect(
				b.peer.request({
					id: "attach",
					type: "open_session",
					cwd: qa.cwd,
					sessionPath: join(qa.sessionDir, "att.jsonl"),
				}),
			).resolves.toMatchObject({ success: true });
			await expect(a.peer.request({ id: "close-a", type: "close_session", sessionId })).resolves.toMatchObject({
				success: true,
			});
			const event = b.peer.waitFor((value) => value.type === "agent_settled" && value.sessionId === sessionId);
			await expect(
				b.peer.request({
					id: "prompt-b",
					type: "prompt",
					sessionId,
					message: "survivor",
				}),
			).resolves.toMatchObject({ success: true });
			await expect(event).resolves.toMatchObject({ sessionId });
			expect(
				b.peer.messages.filter((value) => value.type === "agent_settled" && value.sessionId === sessionId),
			).toHaveLength(1);
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
			b.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("does not close or stop events for the surviving attachment", async () => {
		const qa = scratch("live");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		try {
			const path = join(qa.sessionDir, "live.jsonl");
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
			await expect(b.peer.request({ id: "state", type: "get_state", sessionId })).resolves.toMatchObject({
				success: true,
			});
			expect(b.peer.messages.some((value) => value.type === "session_closed" && value.sessionId === sessionId)).toBe(
				false,
			);
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
			b.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});
});
