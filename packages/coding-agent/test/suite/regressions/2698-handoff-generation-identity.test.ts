/**
 * Regression for senpi#2698: after a handoff to a different engine build, `host status` listed the new
 * generation with the build of the process that ran the handoff. The successor here runs from a package
 * directory whose `package.json` carries another version, so it really is another build.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../../src/config.ts";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { gcHostEndpoints } from "../../../src/modes/rpc/host-gc.ts";
import { handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import { readHostStatus } from "../../../src/modes/rpc/host-status.ts";
import {
	endpointScratch,
	hostArgs,
	hostEnv,
	realHost,
	supervisorLaunch,
	sweepEndpointScratches,
	trackSupervisor,
} from "../../helpers/rpc-host-endpoint-scratch.ts";

afterEach(sweepEndpointScratches, 180_000);

const OTHER_BUILD = "2099.1.1";

function otherBuildPackageDir(root: string): string {
	const dir = join(root, "other-build");
	mkdirSync(dir, { recursive: true });
	const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version: OTHER_BUILD }));
	return dir;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	return JSON.parse(await readFile(path, "utf8").catch(() => "null"));
}

describe.skipIf(process.platform === "win32")("a handoff to a different engine build", () => {
	it("records the successor's own build in its generation, not the build that ran the handoff", async () => {
		const qa = endpointScratch("2698");
		await realHost(qa, qa.legacy);
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		const packageDir = otherBuildPackageDir(qa.agentDir);

		const result = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: { ...hostEnv(qa), PI_PACKAGE_DIR: packageDir, SENPI_PACKAGE_DIR: packageDir },
			_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
		});
		if (result.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(result)}`);
		trackSupervisor(result.pid);

		expect((await probeHost({ socket: qa.legacy }))?.engineVersion).toBe(OTHER_BUILD);
		expect(OTHER_BUILD).not.toBe(VERSION);
		const record = await readJson(generationPaths(paths, result.instanceId).pidFile);
		expect(record).toMatchObject({ pid: result.pid, engineVersion: OTHER_BUILD, engineOrdinal: [2099, 1, 1, 0, 0] });
		const status = await readHostStatus({ socket: qa.legacy, agentDir: qa.agentDir });
		expect(status.generations.find((row) => row.instanceId === result.instanceId)).toMatchObject({
			current: true,
			engineVersion: OTHER_BUILD,
		});
	}, 240_000);

	it("keeps a just-spawned successor through a gc pass, with no engine version claimed for it yet", async () => {
		const qa = endpointScratch("2698-gc");
		await realHost(qa, qa.legacy);
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		const packageDir = otherBuildPackageDir(qa.agentDir);
		const spawned: { record: Record<string, unknown> | null } = { record: null };

		const result = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: { ...hostEnv(qa), PI_PACKAGE_DIR: packageDir, SENPI_PACKAGE_DIR: packageDir },
			_test: {
				launch: supervisorLaunch,
				readinessTimeoutMs: 60_000,
				// The successor is running but has not answered on the socket: a gc pass now must keep it.
				afterSpawn: async (pid) => {
					await gcHostEndpoints(qa.agentDir);
					const settings = await readJson(paths.settingsFile);
					const instanceId = typeof settings?.instanceId === "string" ? settings.instanceId : "";
					spawned.record = await readJson(generationPaths(paths, instanceId).pidFile);
					expect(spawned.record).toMatchObject({ pid });
				},
			},
		});
		if (result.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(result)}`);
		trackSupervisor(result.pid);

		expect(spawned.record).not.toBeNull();
		expect(spawned.record?.engineVersion ?? null).not.toBe(VERSION);
		expect(await readJson(generationPaths(paths, result.instanceId).pidFile)).toMatchObject({
			engineVersion: OTHER_BUILD,
		});
	}, 240_000);

	it("reads a generation record that names no build as an unknown version, and gc and ensure still use it", async () => {
		const qa = endpointScratch("2698-unknown");
		const pid = await realHost(qa, qa.legacy);
		const paths = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });
		const instanceId = (await probeHost({ socket: qa.legacy }))?.instanceId ?? "";
		const pidFile = generationPaths(paths, instanceId).pidFile;
		const { engineVersion: _version, engineOrdinal: _ordinal, ...withoutBuild } = (await readJson(pidFile)) ?? {};
		await writeFile(pidFile, JSON.stringify(withoutBuild));

		const status = await readHostStatus({ socket: qa.legacy, agentDir: qa.agentDir });
		expect(status.generations.find((row) => row.instanceId === instanceId)).toMatchObject({
			pid,
			current: true,
			engineVersion: null,
		});
		const gc = await gcHostEndpoints(qa.agentDir);
		expect(gc.kept.map((entry) => entry.reason)).toContain("live_generation");
		const attached = await ensureHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(),
			env: hostEnv(qa),
			_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
		});
		attached.release();
		expect(attached).toMatchObject({ pid, reused: true });
		expect(await readJson(pidFile)).toMatchObject({ pid, instance_id: instanceId });
	}, 240_000);
});
