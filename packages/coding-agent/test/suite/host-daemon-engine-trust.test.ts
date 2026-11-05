/**
 * Security contract (omo#10762, design r13 5.5): a host daemon or handover successor receives the
 * spawning engine's adopted generation through `forced`, with an empty `restore` and never the hop,
 * and never a marker or hop that merely sits in the spawner's environment.
 */
import { describe, expect, it } from "vitest";
import {
	adoptedEngineTrust,
	classifyTrustArrival,
	engineTrustHandOffEnvironment,
	parseEngineTrustMarker,
	recordAdoptedEngineTrust,
	serializeEngineTrustMarker,
} from "../../src/engine-trust/index.ts";
import { daemonEnvironment } from "../../src/modes/rpc/host-daemon-env.ts";
import { createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { initialHostEnvironment, successorHostEnvironment } from "../../src/modes/rpc/host-spawn-environment.ts";
import { serverMarker } from "./engine-trust-fixtures.ts";

describe("a host daemon and the engine trust generation", () => {
	it("never inherits a marker or a hop from the spawner's environment", () => {
		for (const platform of ["linux", "win32"] as const) {
			const env = daemonEnvironment(
				{ PATH: "/bin", SENPI_ENGINE_TRUST: serializeEngineTrustMarker(serverMarker), SENPI_ENGINE_TRUST_HOP: "1" },
				{},
				{},
				platform,
			);
			expect(env, platform).toEqual({ PATH: "/bin" });
		}
	});

	it("hands off the adopted generation with an empty restore, the closure and no hop", () => {
		const handOff = engineTrustHandOffEnvironment(serverMarker, "linux");
		expect(classifyTrustArrival(handOff, "linux")).toEqual({
			hop: false,
			marker: { kind: "addressed", marker: { ...serverMarker, restore: {} } },
		});
		expect(handOff).toEqual({
			NODE_EXTRA_CA_CERTS: serverMarker.file,
			SENPI_ENGINE_TRUST: serializeEngineTrustMarker({ ...serverMarker, restore: {} }),
			SSL_CERT_FILE: serverMarker.defaults?.file,
			SSL_CERT_DIR: serverMarker.defaults?.dir,
		});
	});

	it("adds the hand-off to an initial and a successor daemon spawn only after this process adopted a generation", () => {
		const paths = createHostDaemonPaths({ socket: "/home/u/.omo/agent/host.sock", agentDir: "/home/u/.omo/agent" });
		const spawns = {
			initial: () => initialHostEnvironment({ paths, instanceId: "i", generation: 1 }),
			successor: () => successorHostEnvironment({ paths, instanceId: "i", generation: 2 }),
		};
		expect(adoptedEngineTrust()).toBeUndefined();
		for (const [kind, spawn] of Object.entries(spawns)) {
			expect(spawn().SENPI_ENGINE_TRUST, kind).toBeUndefined();
			expect(spawn().NODE_EXTRA_CA_CERTS, kind).toBeUndefined();
		}

		recordAdoptedEngineTrust(serverMarker);
		for (const [kind, spawn] of Object.entries(spawns)) {
			const env = spawn();
			expect(env.NODE_EXTRA_CA_CERTS, kind).toBe(serverMarker.file);
			expect(parseEngineTrustMarker(env.SENPI_ENGINE_TRUST ?? "")?.restore, kind).toEqual({});
			expect(env.SENPI_ENGINE_TRUST_HOP, kind).toBeUndefined();
			expect(env.SSL_CERT_FILE, kind).toBe(serverMarker.defaults?.file);
		}
	});
});
