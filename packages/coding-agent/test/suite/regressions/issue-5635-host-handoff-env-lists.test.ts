// senpi#5635: the supervisor hand-off list has ONE owner (host-identity-env.ts). The watchdog scrub, the daemon env
// filter and the agent-facing child env all derive from it, so a name added to one cannot be missed by another.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { daemonEnvIsAllowed, isTransientDaemonEnvName } from "../../../src/modes/rpc/host-daemon-env.ts";
import { HOST_DAEMON_DIR_ENV } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { EXPECTED_RUNTIME_BUILD_ID_ENV } from "../../../src/modes/rpc/host-idle-handover.ts";
import {
	childEnvironmentOf,
	HOST_GENERATION_ENV,
	HOST_HANDOFF_ENV_NAMES,
	HOST_INSTANCE_ID_ENV,
	HOST_WATCH_ENV_NAMES,
	INTERNAL_KEY_STDIN_ENV,
	isHostHandoffEnvName,
	ORIGIN_HOST_INSTANCE_ENV,
	publishHostInstanceId,
} from "../../../src/modes/rpc/host-identity-env.ts";
import { HOST_WATCH_LIFETIME_FIFO_ENV } from "../../../src/modes/rpc/host-lifetime-binding.ts";
import { originHostInstance } from "../../../src/modes/rpc/host-observe-request.ts";
import {
	HOST_CLEANUP_PATHS_ENV,
	HOST_PUBLIC_SOCKET_ENV,
	HOST_SCRATCH_DIR_ENV,
	HOST_WATCH_FD_ENV,
	HOST_WATCH_PPID_ENV,
	HOST_WATCH_PSTART_ENV,
	HOST_WATCH_PSTART_TICKS_ENV,
	scrubHostWatchdogEnv,
} from "../../../src/modes/rpc/host-watchdog.ts";
import { SOCKET_SECRET_FILE_ENV } from "../../../src/modes/rpc/socket-transport.ts";

const OWNER_SOURCE = fileURLToPath(new URL("../../../src/modes/rpc/host-identity-env.ts", import.meta.url));

describe("issue #5635 one owner for the host hand-off names", () => {
	it("the owner module stays import-free", () => {
		expect(readFileSync(OWNER_SOURCE, "utf8")).not.toMatch(/^\s*import\s/mu);
	});

	it("every hand-off constant the host's readers use is in the owner list", () => {
		const readers = [
			HOST_WATCH_FD_ENV,
			HOST_WATCH_PPID_ENV,
			HOST_WATCH_PSTART_ENV,
			HOST_WATCH_PSTART_TICKS_ENV,
			HOST_WATCH_LIFETIME_FIFO_ENV,
			HOST_SCRATCH_DIR_ENV,
			HOST_PUBLIC_SOCKET_ENV,
			HOST_CLEANUP_PATHS_ENV,
			INTERNAL_KEY_STDIN_ENV,
			SOCKET_SECRET_FILE_ENV,
			HOST_DAEMON_DIR_ENV,
			HOST_INSTANCE_ID_ENV,
			HOST_GENERATION_ENV,
			EXPECTED_RUNTIME_BUILD_ID_ENV,
		];
		expect([...readers].sort()).toEqual([...HOST_HANDOFF_ENV_NAMES].sort());
	});

	it("the watchdog scrub deletes exactly the watch names, and keeps the generation identity", () => {
		// Given: an env holding the whole hand-off.
		const env: NodeJS.ProcessEnv = Object.fromEntries(HOST_HANDOFF_ENV_NAMES.map((name) => [name, "synthetic"]));

		// When: the host consumes its supervisor binding.
		scrubHostWatchdogEnv(env);

		// Then: the watch names are gone and nothing else is.
		const remaining = HOST_HANDOFF_ENV_NAMES.filter(
			(name) => !(HOST_WATCH_ENV_NAMES as readonly string[]).includes(name),
		);
		expect(Object.keys(env).sort()).toEqual([...remaining].sort());
	});

	it("a daemon never inherits a hand-off, future internal-key or origin name, and keeps the user's tunables", () => {
		for (const name of HOST_HANDOFF_ENV_NAMES) {
			expect(daemonEnvIsAllowed(name, "linux")).toBe(false);
			expect(isTransientDaemonEnvName(name)).toBe(true);
		}
		expect(daemonEnvIsAllowed("SENPI_RPC_INTERNAL_KEY_FUTURE", "linux")).toBe(false);
		expect(daemonEnvIsAllowed(ORIGIN_HOST_INSTANCE_ENV, "linux")).toBe(false);
		expect(daemonEnvIsAllowed("PI_PROMPT_CACHE_SAFE_WAIT_SECONDS", "linux")).toBe(false);
		expect(daemonEnvIsAllowed("SENPI_RPC_HOST_IDLE_EXIT_MS", "linux")).toBe(true);
		expect(daemonEnvIsAllowed("SENPI_RPC_KEY_ROOT", "linux")).toBe(true);
	});
});

describe("issue #5635 origin attribution replaces the instance id in children", () => {
	it("a child env carries the origin, a blank id passes an inherited origin through", () => {
		expect(childEnvironmentOf({ [HOST_INSTANCE_ID_ENV]: "g1" }, "linux")).toEqual({
			[ORIGIN_HOST_INSTANCE_ENV]: "g1",
		});
		expect(childEnvironmentOf({ [HOST_INSTANCE_ID_ENV]: "  ", [ORIGIN_HOST_INSTANCE_ENV]: "g0" }, "linux")).toEqual({
			[ORIGIN_HOST_INSTANCE_ENV]: "g0",
		});
	});

	it("win32 matches names case-insensitively and still reads the id for the origin", () => {
		const child = childEnvironmentOf({ senpi_rpc_host_instance_id: "g2", Path: "C:\\bin" }, "win32");
		expect(child).toEqual({ Path: "C:\\bin", [ORIGIN_HOST_INSTANCE_ENV]: "g2" });
		expect(isHostHandoffEnvName("senpi_rpc_internal_key_stdin", "win32")).toBe(true);
		expect(isHostHandoffEnvName("senpi_rpc_internal_key_stdin", "linux")).toBe(false);
	});

	it("a client names its host by the id inside the host and by the origin in a child", () => {
		expect(originHostInstance({ [HOST_INSTANCE_ID_ENV]: "g1" })).toBe("g1");
		expect(originHostInstance(childEnvironmentOf({ [HOST_INSTANCE_ID_ENV]: "g1" }, "linux"))).toBe("g1");
		expect(originHostInstance({})).toBeUndefined();
	});

	it("a socket host publishes its self-chosen id only when none (or a blank one) was handed to it", () => {
		const bare: NodeJS.ProcessEnv = {};
		publishHostInstanceId("self", bare);
		expect(bare[HOST_INSTANCE_ID_ENV]).toBe("self");
		const blank: NodeJS.ProcessEnv = { [HOST_INSTANCE_ID_ENV]: " " };
		publishHostInstanceId("self", blank);
		expect(blank[HOST_INSTANCE_ID_ENV]).toBe("self");
		const ensured: NodeJS.ProcessEnv = { [HOST_INSTANCE_ID_ENV]: "told" };
		publishHostInstanceId("self", ensured);
		expect(ensured[HOST_INSTANCE_ID_ENV]).toBe("told");
	});
});
