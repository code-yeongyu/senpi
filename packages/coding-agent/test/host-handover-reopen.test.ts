import { mkdtempSync, realpathSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { readHandoverParkedSessions, recordHandoverParkedSession } from "../src/modes/rpc/host-handover-parked.ts";
import { reopenHandoverParkedSessions } from "../src/modes/rpc/host-handover-reopen.ts";
import { parkWithTaskStatus } from "./suite/regressions/3853-park-context-support.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// senpi#3853: terminal task records are never turned back into active writers.
it.each(["completed", "cancelled", "error", "failed", "lost", "interrupted"])(
	"drops a %s task park without invoking the opener",
	async (task_status) => {
		const { agentDir, socket, daemonDir } = await parkedRig();
		const [park] = await readHandoverParkedSessions(daemonDir);
		if (!park) throw new Error("missing park");
		await parkWithTaskStatus(agentDir, park.sessionPath, daemonDir, task_status);
		expect(await readHandoverParkedSessions(daemonDir)).toEqual([
			expect.objectContaining({ contextOverlay: { task_status } }),
		]);
		const open = vi.fn(async () => {});
		let passes = 0;
		// The test observes one pass, not the watch's production timing policy.
		await reopenHandoverParkedSessions(open, agentDir, socket, {
			hostInstance: "successor",
			shouldReopen: () => passes++ === 0,
		});
		expect(open).not.toHaveBeenCalled();
		expect(await readHandoverParkedSessions(daemonDir)).toEqual([]);
	},
);

async function parkedRig() {
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "hhr-")));
	dirs.push(agentDir);
	const socket = join(agentDir, "host.sock");
	const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
	const sessionPath = join(agentDir, "retained.jsonl");
	await writeFile(
		sessionPath,
		`${JSON.stringify({ type: "session", version: 3, id: "32820000-0000-4000-8000-000000000001", timestamp: new Date(0).toISOString(), cwd: agentDir })}\n`,
		"utf8",
	);
	await recordHandoverParkedSession(daemonDir, {
		sessionPath,
		durableSessionId: "32820000-0000-4000-8000-000000000001",
		retainOnDisconnect: true,
		cwd: agentDir,
	});
	return { agentDir, socket, daemonDir };
}

describe("handover-parked reopen watch on a draining host (senpi#3282)", () => {
	it("never consumes the park while its host drains", async () => {
		const { agentDir, socket, daemonDir } = await parkedRig();
		const opened: string[] = [];
		const open = async (entry: { readonly sessionPath: string }): Promise<void> => {
			opened.push(entry.sessionPath);
		};

		await reopenHandoverParkedSessions(open, agentDir, socket, {
			hostInstance: "draining-predecessor",
			shouldReopen: () => false,
		});

		expect(opened).toEqual([]);
		expect(await readHandoverParkedSessions(daemonDir)).toHaveLength(1);
	});

	it("keeps the park when the drain starts while a reopen is in flight", async () => {
		const { agentDir, socket, daemonDir } = await parkedRig();
		let draining = false;
		const open = async (): Promise<void> => {
			draining = true;
		};

		await reopenHandoverParkedSessions(open, agentDir, socket, {
			hostInstance: "predecessor",
			shouldReopen: () => !draining,
		});

		expect(await readHandoverParkedSessions(daemonDir)).toHaveLength(1);
	});
});
