// senpi#5728 (S36, plan amendment A4): the shipped CLI's shared RPC host on a Unix socket (`--mode rpc --listen`, the
// host the desktop engine runs) executes a model-issued tool call on the prepared pipeline with no batch-store
// configuration. The loop has one pipeline and fails closed (BatchStoreMissingError) without a store, so a successful
// tool result on this host is the prepared pipeline; no default writer persists a receipt (that sink is S18b part 3).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startFakeModelServer } from "../../helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import {
	connectPeer,
	openedSessionId,
	scratch,
	spawnRpc,
	stopChild,
	waitForStderr,
} from "../../helpers/rpc-socket-host-support.ts";

it("the Unix-socket RPC host runs a tool call on the prepared pipeline on default config", async () => {
	const qa = scratch("s36-prepared");
	const fake = await startFakeModelServer();
	writeRpcModelsJson(qa.agentDir, fake.origin);
	writeFileSync(join(qa.cwd, "probe.txt"), "probe contents\n");
	const child = spawnRpc(
		["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
		qa,
		undefined,
		{},
	);
	try {
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const client = await connectPeer(qa.socketPath);
		try {
			const sessionId = openedSessionId(
				await client.peer.request({ id: "open", type: "open_session", cwd: qa.cwd }),
			);
			const settled = client.peer.waitFor(
				(value) => value.type === "agent_settled" && value.sessionId === sessionId,
			);
			await expect(
				client.peer.request({ id: "prompt", type: "prompt", sessionId, message: "tool-call-read" }),
			).resolves.toMatchObject({ success: true });
			await settled;
			const state = await client.peer.request({ id: "state", type: "get_state", sessionId });
			const sessionFile = (state.data as { sessionFile?: unknown } | undefined)?.sessionFile;
			if (typeof sessionFile !== "string") throw new Error(`no session file: ${JSON.stringify(state)}`);
			const entries = readFileSync(sessionFile, "utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map(
					(line) =>
						JSON.parse(line) as {
							type?: string;
							customType?: string;
							message?: { role?: string; toolCallId?: string; isError?: boolean; content?: unknown };
						},
				);
			const results = entries.flatMap((entry) =>
				entry.type === "message" && entry.message?.role === "toolResult" ? [entry.message] : [],
			);
			expect(results).toMatchObject([{ toolCallId: "toolu_fake_read", isError: false }]);
			expect(JSON.stringify(results[0]?.content)).toContain("probe contents");
			expect(entries.some((entry) => entry.customType === "execution-pipeline")).toBe(false);
		} finally {
			client.peer.close();
			client.socket.destroy();
		}
	} finally {
		await stopChild(child);
		await fake.close();
	}
}, 60_000);
