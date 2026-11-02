/**
 * `get_protocol_info` identity: who this host IS, which build it runs, and what it loaded.
 *
 * A client that shares one machine-wide daemon decides "is this the same host I talked
 * to?", "is my build newer?" and "does it load my extensions?" from this reply alone -
 * never from a `serverVersion` string comparison. The identity therefore has to survive
 * the trip through a REAL host process: the launch profile is derived from the host's
 * own argv, so only a spawned host can prove that `--session-runtime`, `--multi-session`
 * and `--extension` reach the wire.
 *
 * Cells: the pure derivation (argv -> profile, env -> generation), then one spawned
 * socket host (the daemon path) and one spawned classic stdio host (the other answer
 * site, `connection-handler.ts`).
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { engineBuildIdentity, engineBuildIdentityFrom } from "../src/core/engine-build-identity.ts";
import { hostGeneration, hostLaunchProfile } from "../src/modes/rpc/protocol-identity.ts";
import { MOCK_MODEL, MOCK_PROVIDER } from "./helpers/rpc-hermetic.ts";
import {
	cleanupSpawnedHosts,
	expectedProfileId,
	probeSocket,
	type RecordValue,
	scratch,
	spawnHost,
	waitForJsonLine,
	waitForStderr,
} from "./rpc-protocol-identity-support.ts";

afterEach(cleanupSpawnedHosts);

describe("hostLaunchProfile", () => {
	it("records the host's own session runtime, multi-session flag and sorted ABSOLUTE extension roots", () => {
		const profile = hostLaunchProfile(
			["--mode", "rpc", "--multi-session", "--listen", "unix:///tmp/x.sock", "--extension", "./b", "-e", "/abs/a"],
			"/work",
		);

		expect(profile.core).toEqual({
			extensions: ["/abs/a", "/work/b"],
			multi_session: true,
			session_runtime: "in-process",
		});
		expect(profile.profile_id).toBe(expectedProfileId(profile.core));
	});

	it("is stable under extension ORDER and duplicates, and changes when the session runtime changes", () => {
		const one = hostLaunchProfile(
			["--mode", "rpc", "--listen", "unix:///s", "-e", "/a", "-e", "/b", "-e", "/a"],
			"/w",
		);
		const other = hostLaunchProfile(["--mode", "rpc", "--listen", "unix:///s", "-e", "/b", "-e", "/a"], "/w");
		const worker = hostLaunchProfile(
			["--mode", "rpc", "--listen", "unix:///s", "--session-runtime", "worker", "-e", "/a", "-e", "/b"],
			"/w",
		);

		expect(one.profile_id).toBe(other.profile_id);
		expect(one.core.extensions).toEqual(["/a", "/b"]);
		expect(worker.profile_id).not.toBe(one.profile_id);
		expect(worker.core.session_runtime).toBe("worker");
	});

	it("reports a classic host as a worker-runtime, single-session profile with no extensions", () => {
		expect(hostLaunchProfile(["--mode", "rpc"], "/w").core).toEqual({
			extensions: [],
			multi_session: false,
			session_runtime: "worker",
		});
	});
});

describe("hostGeneration", () => {
	it("reads a non-negative integer generation from the environment and rejects everything else", () => {
		const table: ReadonlyArray<readonly [string | undefined, number]> = [
			["3", 3],
			["0", 0],
			[undefined, 0],
			["", 0],
			["abc", 0],
			["-1", 0],
			["2.5", 0],
			[" 4 ", 0],
		];

		for (const [value, expected] of table) {
			expect([value, hostGeneration({ SENPI_RPC_HOST_GENERATION: value })]).toEqual([value, expected]);
		}
	});
});

describe("get_protocol_info identity", () => {
	it("advertises instance, generation, engine build and launch profile from a real socket host", async () => {
		const qa = scratch("socket");
		const extensionPath = join(qa.agentDir, "extensions", "probe.ts");
		const child = spawnHost(
			[
				"--mode",
				"rpc",
				"--listen",
				`unix://${qa.socketPath}`,
				"--session-runtime",
				"in-process",
				"--extension",
				extensionPath,
			],
			qa,
			{ SENPI_RPC_HOST_GENERATION: "9" },
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);

		const first = await probeSocket(qa.socketPath, "probe-1");
		const second = await probeSocket(qa.socketPath, "probe-2");

		const core = { extensions: [extensionPath], multi_session: true, session_runtime: "in-process" };
		expect(first).toMatchObject({
			protocolVersion: 1,
			serverVersion: VERSION,
			mode: "multi",
			instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			generation: 9,
			engineVersion: engineBuildIdentity().text,
			engineOrdinal: [...engineBuildIdentityFrom({ version: VERSION }).ordinal],
			launch_profile: { profile_id: expectedProfileId(core), core },
		});
		expect(second.instanceId).toBe(first.instanceId);
		expect((second.launch_profile as RecordValue).profile_id).toBe((first.launch_profile as RecordValue).profile_id);
	}, 60_000);

	it("advertises the same identity fields from a classic stdio host", async () => {
		const qa = scratch("classic");
		const child = spawnHost(["--mode", "rpc", "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL], qa);

		const reply = waitForJsonLine(child.stdout, (value) => value.id === "classic-probe");
		child.stdin.write(`${JSON.stringify({ id: "classic-probe", type: "get_protocol_info" })}\n`);

		expect((await reply).data).toMatchObject({
			protocolVersion: 1,
			mode: "classic",
			instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			generation: 0,
			engineVersion: engineBuildIdentity().text,
			launch_profile: {
				profile_id: expect.stringMatching(/^[0-9a-f]{64}$/),
				core: { extensions: [], multi_session: false, session_runtime: "worker" },
			},
		});
	}, 60_000);
});
