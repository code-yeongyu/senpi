import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";
import {
	connectPeer,
	messageText,
	openedSessionId,
	scratch,
	spawnRpc,
	waitForStderr,
} from "./helpers/rpc-socket-host-support.ts";

/** What a connection not attached to a session may see of it: its own responses and the broadcast lifecycle. */
const FOREIGN_VISIBLE = new Set([
	"response",
	"session_opened",
	"session_lifecycle",
	"agent_start",
	"agent_settled",
	"agent_idle",
	"session_closed",
]);

describe("RPC Unix-socket multi-connection host", () => {
	it("parses socket listeners as multi-session RPC", () => {
		expect(parseArgs(["--mode", "rpc", "--listen", "unix:///tmp/senpi.sock"])).toMatchObject({
			mode: "rpc",
			multiSession: true,
			listen: "unix:///tmp/senpi.sock",
		});
		expect(parseArgs(["--mode", "rpc", "--listen", "/tmp/senpi.sock"])).toMatchObject({
			multiSession: true,
			listen: "/tmp/senpi.sock",
		});
	});

	it("delivers foreign commands only after attachment, survives malformed frames, and reconnects", async () => {
		const qa = scratch("semantics");
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
			a.peer.writeMalformed("{bad first frame");
			await expect(
				a.peer.waitFor((value) => value.command === "parse" && value.success === false),
			).resolves.toMatchObject({
				type: "response",
				command: "parse",
				success: false,
			});
			await expect(b.peer.request({ id: "probe-b", type: "get_protocol_info" })).resolves.toMatchObject({
				success: true,
			});

			const opened = await a.peer.request({
				id: "open-a",
				type: "open_session",
				cwd: qa.cwd,
			});
			const sessionId = openedSessionId(opened);

			// An unattached connection's session command is refused, and nothing of the session reaches it (senpi#6245).
			await expect(
				b.peer.request({
					id: "foreign-prompt",
					type: "prompt",
					sessionId,
					message: "refused-before-attach",
				}),
			).resolves.toMatchObject({ success: false, error: "session_not_attached" });
			expect(
				b.peer.messages
					.filter((value) => value.sessionId === sessionId && !FOREIGN_VISIBLE.has(String(value.type)))
					.filter((value) => value.type !== "response")
					.map((value) => value.type),
			).toEqual([]);

			// Once it attaches, the same connection's prompt is delivered.
			await expect(
				b.peer.request({
					id: "attach-b",
					type: "attach_session",
					sessionId,
					durableSessionId: (opened.data as { state?: { sessionId?: string } }).state?.sessionId,
				}),
			).resolves.toMatchObject({ success: true });
			const settledA = a.peer.waitFor((value) => value.type === "agent_settled" && value.sessionId === sessionId);
			await expect(
				b.peer.request({
					id: "attached-prompt",
					type: "prompt",
					sessionId,
					message: "unique-424242",
				}),
			).resolves.toMatchObject({ success: true, sessionId });
			await settledA;

			const transcript = await b.peer.request({
				id: "foreign-transcript",
				type: "get_messages",
				sessionId,
			});
			const messages = ((transcript.data as { messages?: unknown[] }).messages ?? []).map(messageText);
			expect(messages).toContain("unique-424242");

			a.peer.writeMalformed("not-json-mid-stream");
			await a.peer.waitFor((value) => value.command === "parse" && value.success === false);
			await expect(b.peer.request({ id: "survives-mid", type: "get_state", sessionId })).resolves.toMatchObject({
				success: true,
				sessionId,
			});

			b.peer.close();
			b.socket.destroy();
			const reconnected = await connectPeer(qa.socketPath);
			try {
				await expect(
					reconnected.peer.request({
						id: "reconnected",
						type: "get_state",
						sessionId,
					}),
				).resolves.toMatchObject({ success: true, sessionId });
			} finally {
				reconnected.peer.close();
				reconnected.socket.destroy();
			}
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.socket.destroy();
			await fake.close();
		}
	});
});
