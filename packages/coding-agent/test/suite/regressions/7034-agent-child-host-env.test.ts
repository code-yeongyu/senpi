// senpi#7034: an RPC host holds its own generation identity and launch defaults in process.env. Agent shells were built
// from that env, so every process a session started saw the host's SENPI_RPC_HOST_* identity and its launch-default
// client capabilities, and a senpi started from it adopted them. Protects the agent-child environment contract: those
// names never reach a shell child, everything else (session context, user tunables, socket routing) does, and the
// origin attribution senpi#3272 needs travels under its own read-only name.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getShellEnv, getUserShellEnv } from "../../../src/utils/shell.ts";

const supported = process.platform === "linux" || process.platform === "darwin";

// Literal on purpose: the test's own oracle, independent of the production list it checks.
const HOST_ONLY = {
	SENPI_RPC_HOST_GENERATION: "10",
	SENPI_RPC_HOST_INSTANCE_ID: "outer-host-7034",
	SENPI_RPC_HOST_DAEMON_DIR: "/synthetic/rpc-host-daemon/0123456789abcdef",
	SENPI_RPC_HOST_EXPECTED_RUNTIME_BUILD_ID: "synthetic-build",
	SENPI_RPC_CLIENT_CAPABILITIES: "extension_events",
	SENPI_RPC_INTERNAL_KEY_STDIN: "1",
} as const;

// Names that must pass through byte-for-byte: session context a gate reads, a user tunable in the host namespace,
// socket routing a child CLI uses to reach its host, and an unrelated variable.
const KEEP = {
	PI_SESSION_ID: "session-7034",
	SENPI_RPC_HOST_IDLE_EXIT_MS: "1500",
	OMO_RPC_SOCKET_PATH: "/synthetic/rpc/desktop.sock",
	ISSUE_7034_UNRELATED: "keep",
} as const;

function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const child = spawnSync("sh", ["-c", "env"], { env, encoding: "utf8" });
	expect(child.status).toBe(0);
	const seen: Record<string, string> = {};
	for (const line of child.stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) seen[line.slice(0, at)] = line.slice(at + 1);
	}
	return seen;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe.skipIf(!supported)("issue #7034 agent children never inherit the RPC host's identity", () => {
	it.each([
		["agent shell (getShellEnv)", getShellEnv],
		["user command (getUserShellEnv)", getUserShellEnv],
	])("a child started from the %s sees no host-only name and keeps the rest", (_label, build) => {
		// Given: this process is a host generation that also carries session context.
		for (const [name, value] of Object.entries({ ...HOST_ONLY, ...KEEP })) vi.stubEnv(name, value);

		// When: a real child is started from the shell environment.
		const seen = childEnv(build());

		// Then: the host-only names are gone, the rest passes through, and the origin names the outer generation.
		expect(Object.keys(HOST_ONLY).filter((name) => name in seen)).toEqual([]);
		for (const [name, value] of Object.entries(KEEP)) expect(seen[name]).toBe(value);
		expect(seen.SENPI_RPC_ORIGIN_HOST_INSTANCE).toBe(HOST_ONLY.SENPI_RPC_HOST_INSTANCE_ID);
		expect(process.env.SENPI_RPC_HOST_INSTANCE_ID).toBe(HOST_ONLY.SENPI_RPC_HOST_INSTANCE_ID);
	});
});
