import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../../src/config.ts";
import { createDaemonDirectories, createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "../../../src/modes/rpc/host-decision.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { isHostGenerationProcess, runAsHostGenerationProcess } from "../../../src/modes/rpc/host-process-role.ts";
import { hostLaunchProfile } from "../../../src/modes/rpc/protocol-identity.ts";
import {
	CAPABILITIES,
	fixturePath,
	refuseToSpawn,
	sandbox,
	spawnDetached,
	startTimeOf,
	sweepSandboxes,
	waitForProtocol,
} from "../../helpers/rpc-host-daemon-sandbox.ts";

afterEach(async () => {
	await sweepSandboxes();
});

describe.skipIf(process.platform === "win32")("issue #2208 host generation ensure policy", () => {
	it("keeps the marker while any overlapping host-generation scope remains active", async () => {
		let releaseOuter!: () => void;
		let releaseInner!: () => void;
		const outer = runAsHostGenerationProcess(() => new Promise<void>((resolve) => (releaseOuter = resolve)));
		const inner = runAsHostGenerationProcess(() => new Promise<void>((resolve) => (releaseInner = resolve)));

		expect(isHostGenerationProcess()).toBe(true);
		releaseOuter();
		await outer;
		expect(isHostGenerationProcess()).toBe(true);
		releaseInner();
		await inner;
		expect(isHostGenerationProcess()).toBe(false);
	});

	it("attaches without handing off when ensure runs inside a host generation", async () => {
		const qa = await sandbox("host-generation-attach");
		const launchProfile = hostLaunchProfile(["--mode", "rpc", "--multi-session"], process.cwd());
		const instanceId = "issue-2208-running-host";
		const pid = await spawnDetached([
			fixturePath(),
			qa.socket,
			VERSION,
			`${CAPABILITIES},${GENERATION_HANDOFF_CAPABILITY}`,
			"answer",
			JSON.stringify({
				instanceId,
				generation: 0,
				engineVersion: "2026.1.1",
				engineOrdinal: [2026, 1, 1, 0, 0],
				launch_profile: launchProfile,
			}),
		]);
		await waitForProtocol(qa.socket);
		const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
		await createDaemonDirectories(paths);
		await writeHostRegistration(paths, {
			record: { pid, processStartTime: await startTimeOf(pid) },
			socket: qa.socket,
			instanceId,
			generation: 0,
			launchProfileId: launchProfile.profile_id,
		});

		const result = await runAsHostGenerationProcess(() =>
			ensureHost({
				socket: qa.socket,
				agentDir: qa.agentDir,
				upgrade: "if-engine-differs",
				_test: { launch: refuseToSpawn },
			}),
		);

		expect(result).toEqual({ pid, socket: qa.socket, reused: true, release: expect.any(Function) });
		result.release();
	});
});
