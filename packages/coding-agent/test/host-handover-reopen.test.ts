import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { readHandoverParkedSessions, recordHandoverParkedSession } from "../src/modes/rpc/host-handover-parked.ts";
import { reopenHandoverParkedSessions } from "../src/modes/rpc/host-handover-reopen.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function parkedRig() {
	const agentDir = mkdtempSync(join(tmpdir(), "hhr-"));
	dirs.push(agentDir);
	const socket = join(agentDir, "host.sock");
	const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
	const sessionPath = join(agentDir, "retained.jsonl");
	await writeFile(sessionPath, "", "utf8");
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
