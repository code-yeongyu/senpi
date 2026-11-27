/**
 * senpi#4269 review M2, against the real multi-session host: the attached TUI only attaches to a
 * session that no release of its own can end, so /quit or a dropped TUI never closes a hosted session.
 */
import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AttachedTui } from "../../src/modes/interactive/attach.ts";
import { AttachRefusedError } from "../../src/modes/interactive/attach-client.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { connectPeer, openedSessionId, scratch, spawnRpc, waitForStderr } from "../helpers/rpc-socket-host-support.ts";

async function realHost() {
	const qa = scratch("attach-retained");
	const fake = await startFakeModelServer();
	writeRpcModelsJson(qa.agentDir, fake.origin);
	const child = spawnRpc(
		["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
		qa,
	);
	await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
	const opener = await connectPeer(qa.socketPath);
	const keyRoot = process.env.SENPI_RPC_KEY_ROOT;
	// The attached TUI authenticates with the host's own key, as `SENPI_RPC_KEY_ROOT` selects it for a user.
	process.env.SENPI_RPC_KEY_ROOT = qa.agentDir;
	return {
		qa,
		opener,
		async close() {
			if (keyRoot === undefined) delete process.env.SENPI_RPC_KEY_ROOT;
			else process.env.SENPI_RPC_KEY_ROOT = keyRoot;
			opener.socket.destroy();
			await fake.close();
		},
	};
}

function view() {
	initTheme("dark");
	return new AttachedTui(new TUI(new VirtualTerminal(80, 24)), () => {});
}

describe("attaching the TUI to a real multi-session host", () => {
	it("refuses a session that is not retained before attaching to it", async () => {
		const host = await realHost();
		try {
			const sessionId = openedSessionId(
				await host.opener.peer.request({ id: "open", type: "open_session", cwd: host.qa.cwd }),
			);
			const refused = await view()
				.connect(host.qa.socketPath, sessionId)
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(refused).toBeInstanceOf(AttachRefusedError);
			expect(refused).toMatchObject({ code: "session_not_retained" });
			const listed = await host.opener.peer.request({ id: "list", type: "list_sessions" });
			expect((listed.data as { sessions: unknown[] }).sessions).toEqual([
				expect.objectContaining({ sessionId, status: "open", attachments: 1, retain_on_disconnect: false }),
			]);
		} finally {
			await host.close();
		}
	}, 60_000);

	it("keeps a retained session open after its opener leaves and the attached TUI quits", async () => {
		const host = await realHost();
		try {
			const sessionId = openedSessionId(
				await host.opener.peer.request({
					id: "open",
					type: "open_session",
					cwd: host.qa.cwd,
					retain_on_disconnect: true,
				}),
			);
			const attached = view();
			await attached.connect(host.qa.socketPath, sessionId);
			expect(await host.opener.peer.request({ id: "leave", type: "release_attachment", sessionId })).toMatchObject({
				success: true,
			});
			await attached.close();
			const listed = await host.opener.peer.request({ id: "list", type: "list_sessions" });
			expect((listed.data as { sessions: unknown[] }).sessions).toEqual([
				expect.objectContaining({ sessionId, status: "open", attachments: 0, retain_on_disconnect: true }),
			]);
		} finally {
			await host.close();
		}
	}, 60_000);
});
