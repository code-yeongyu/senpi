import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { signalGeneration } from "../../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	generationScratch,
	JsonlPeer,
	openedSessionId,
	reapProcessesUnder,
	supervisorLaunch,
	waitForPidGone,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";

// senpi #2285. A superseded generation holding a session whose directory a task owner deleted
// must still park its other sessions and exit, on both session runtimes.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 120_000);

describe.skipIf(process.platform === "win32")("handoff drain with a deleted session directory", () => {
	it.each(["in-process", "worker"])(
		"ends the gone session, parks the other and exits on %s",
		async (runtime) => {
			const qa = generationScratch("2285");
			const peers: JsonlPeer[] = [];
			cleanups.push(async () => {
				for (const peer of peers) peer.destroy();
				await reapProcessesUnder(qa.root);
				await rm(qa.root, { recursive: true, force: true });
			});
			writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
			const host = await ensureHost({
				socket: qa.socket,
				agentDir: qa.agentDir,
				hostArgs: [...GENERATION_HOST_ARGS, "--session-runtime", runtime],
				env: { ...generationEnv(qa), SENPI_RPC_HANDOFF_GRACE_MS: "600000" },
				policy: { idleExitMs: 600_000 },
				_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
			});
			const connect = async () => {
				const peer = await JsonlPeer.connect(qa.socket);
				peers.push(peer);
				return peer;
			};
			const childDir = join(qa.root, "children", "st_gone", "sessions");
			await mkdir(childDir, { recursive: true });
			const child = await connect();
			const gone = openedSessionId(
				await child.request({
					id: "open-gone",
					type: "open_session",
					cwd: qa.cwd,
					sessionPath: join(childDir, "gone.jsonl"),
				}),
			);
			const parent = await connect();
			const kept = openedSessionId(
				await parent.request({
					id: "open-kept",
					type: "open_session",
					cwd: qa.cwd,
					sessionPath: join(qa.sessionDir, "kept.jsonl"),
				}),
			);
			await rm(join(qa.root, "children"), { recursive: true, force: true });

			const goneClosed = child.waitFor((e) => e.type === "session_closed" && e.sessionId === gone, 20_000);
			const keptClosed = parent.waitFor((e) => e.type === "session_closed" && e.sessionId === kept, 20_000);
			expect(signalGeneration(host.pid, "SIGUSR1")).toBe(true);

			const goneRecord = await goneClosed;
			expect(goneRecord).toMatchObject({ reason: "session_dir_removed" });
			expect(goneRecord).not.toHaveProperty("sessionPath");
			expect(await keptClosed).toMatchObject({
				reason: "handoff_parked",
				sessionPath: expect.stringMatching(/kept\.jsonl$/),
			});
			expect(await waitForPidGone(host.pid, 20_000)).toBe(true);
		},
		120_000,
	);
});
