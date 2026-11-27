import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { recordHandoverParkedSession } from "../../../src/modes/rpc/host-handover-parked.ts";
import { reopenHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-reopen.ts";
import { currentResidentWriter } from "../../../src/modes/rpc/host-handover-resident-writer.ts";

it.each(["handover", "retained restart"] as const)("does not open a retired session during %s", async (source) => {
	const agentDir = await mkdtemp(join(tmpdir(), "retirement-"));
	try {
		const socket = join(agentDir, "host.sock");
		const daemonDir = createHostDaemonPaths({ agentDir, socket }).dir;
		const retired = "00000000-0000-4000-8000-000000000001";
		const active = "00000000-0000-4000-8000-000000000002";
		const timestamp = new Date(0).toISOString();
		const writer = await currentResidentWriter();
		for (const id of [retired, active]) {
			const sessionPath = join(agentDir, `${id}.jsonl`);
			await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: agentDir })}\n`);
			await recordHandoverParkedSession(daemonDir, {
				cwd: agentDir,
				sessionPath,
				durableSessionId: id,
				retainOnDisconnect: true,
				parkedBy: "previous",
				...(source === "retained restart" && { residentWriter: { ...writer, bootAtMs: 0 } }),
			});
		}
		const store = join(agentDir, "retired-sessions");
		await mkdir(store);
		await writeFile(join(store, `${retired}.json`), JSON.stringify({ version: 1, retiredAt: timestamp, reason: "requested" }));

		const open = vi.fn(async (_entry: { durableSessionId?: string }) => {});
		let passes = 0;
		await reopenHandoverParkedSessions(open, agentDir, socket, {
			hostInstance: "successor",
			shouldReopen: () => passes++ < 3,
			onProgress: () => {},
		});
		expect(open.mock.calls.map(([entry]) => entry.durableSessionId)).toEqual([active]);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
