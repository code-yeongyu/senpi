/**
 * `find_session` on a worker-runtime host (senpi#6429). That host runs each session in its own worker, so its session
 * registry carries no agent directory, and `find_session` used to answer `find_session_unsupported` there although the
 * host has one. It now reads the host's own directory. `move_session` reads the registry's and must keep refusing on
 * such a host: finding a session's file is not what switches moving on.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

const ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9e6";
/** A real host is spawned; its first command pays the cold start. */
const REAL_HOST_MS = 120_000;

// senpi#6429
it(
	"#given a worker-runtime host and a session file in its own agent directory #when find_session names the session's durable id #then the host answers the file",
	async () => {
		const host = await startWorkerHost(undefined, { waitForReady: true });
		try {
			const dir = getDefaultSessionDir(host.cwd, host.agentDir);
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `2026-11-11T00-00-00-000Z_${ID}.jsonl`);
			const header = { type: "session", version: 3, id: ID, timestamp: "2026-11-11T00:00:00.000Z", cwd: host.cwd };
			writeFileSync(file, `${JSON.stringify(header)}\n`);

			const answer = await host.request({ type: "find_session", durableSessionId: ID });

			expect(answer).toMatchObject({
				success: true,
				command: "find_session",
				data: { found: { sessionPath: file, cwd: host.cwd, open: false } },
			});
		} finally {
			await host.dispose();
		}
	},
	REAL_HOST_MS,
);

it(
	"#given the same kind of host #when move_session is sent #then it is still refused move_unsupported",
	async () => {
		const host = await startWorkerHost(undefined, { waitForReady: true });
		try {
			const answer = await host.request({ type: "move_session", op: "status", moveId: "move-w1" });

			expect(answer).toMatchObject({ success: false, command: "move_session" });
			expect(JSON.stringify(answer)).toContain("move_unsupported");
		} finally {
			await host.dispose();
		}
	},
	REAL_HOST_MS,
);
