// senpi#5840: `--headless` starts the headless engine: the machine-owned multi-session host on its own endpoint
// (`<agentDir>/rpc/headless.sock`), serving `get_state` and attach to clients and keeping a session open after the
// client that opened it leaves. `--help` documents both engine entry points.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { headlessSocketPath } from "../../../src/modes/headless/headless-host.ts";
import { startFakeModelServer } from "../../helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";
import {
	connectPeer,
	openedSessionId,
	scratch,
	spawnRpc,
	stopChild,
	waitForStderr,
} from "../../helpers/rpc-socket-host-support.ts";

it("--headless serves a machine-owned host on the headless endpoint", async () => {
	const qa = scratch("5840-headless");
	// The headless endpoint lives under the agent dir; a short root keeps it inside the 103-byte socket path limit.
	const agentDir = mkdtempSync(join("/tmp", "s5840h-"));
	const fake = await startFakeModelServer();
	writeRpcModelsJson(agentDir, fake.origin);
	const endpoint = headlessSocketPath(agentDir);
	const child = spawnRpc(["--headless", "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL], qa, undefined, {
		SENPI_CODING_AGENT_DIR: agentDir,
	});
	try {
		await waitForStderr(child, `senpi rpc listening on unix://${endpoint}`);
		const first = await connectPeer(endpoint);
		let sessionId: string;
		let durableSessionId: unknown;
		try {
			sessionId = openedSessionId(await first.peer.request({ id: "open", type: "open_session", cwd: qa.cwd }));
			const state = await first.peer.request({ id: "state", type: "get_state", sessionId });
			expect(state).toMatchObject({ success: true });
			durableSessionId = (state.data as { sessionId?: unknown } | undefined)?.sessionId;
			expect(typeof durableSessionId).toBe("string");
		} finally {
			first.peer.close();
			first.socket.destroy();
		}
		const second = await connectPeer(endpoint);
		try {
			const listed = await second.peer.request({ id: "list", type: "list_sessions" });
			expect((listed.data as { sessions?: unknown } | undefined)?.sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ sessionId, status: "open", retain_on_disconnect: true }),
				]),
			);
			await expect(
				second.peer.request({ id: "attach", type: "attach_session", sessionId, durableSessionId }),
			).resolves.toMatchObject({ success: true, data: { sessionId, attached: true } });
		} finally {
			second.peer.close();
			second.socket.destroy();
		}
		expect(child.exitCode).toBeNull();
	} finally {
		await stopChild(child);
		await fake.close();
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 90_000);

it("--help documents --hand and --headless", () => {
	const qa = scratch("5840-help");
	const result = spawnSync(
		process.execPath,
		[join(import.meta.dirname, "..", "..", "..", "src", "cli.ts"), "--help"],
		{
			cwd: qa.cwd,
			env: {
				...hostSpawnEnv(),
				...hermeticProviderEnv(),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				NO_COLOR: "1",
				SENPI_RUNTIME: "node",
				SENPI_CODING_AGENT_DIR: qa.agentDir,
			},
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	expect(result.status).toBe(0);
	const lines = result.stdout.split("\n").map((line) => line.trim());
	expect(lines.some((line) => line.startsWith("--hand "))).toBe(true);
	expect(lines.some((line) => line.startsWith("--headless "))).toBe(true);
}, 90_000);
