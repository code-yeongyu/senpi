// senpi#5635: an RPC host keeps its supervisor hand-off (internal-key sentinel, watchdog binding, generation
// identity) in its own process.env for its whole life. Agent shells are built from that env, so every senpi CLI an
// agent started from its shell adopted the parent's identity, and with the sentinel set it waited for a key on an
// unrelated stdin and exited internal_key_unavailable. The shell env must drop exactly those names and nothing else.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getShellEnv, getUserShellEnv } from "../../../src/utils/shell.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

// The supervisor -> host hand-off, written by spawnHostChild and the ensure's forced identity. Literal on purpose:
// this list is the test's own oracle, independent of the production list it checks.
const HANDOFF = [
	"SENPI_RPC_INTERNAL_KEY_STDIN",
	"SENPI_RPC_INTERNAL_KEY_FUTURE",
	"SENPI_RPC_SOCKET_SECRET_FILE",
	"SENPI_RPC_HOST_LIFETIME_FIFO",
	"SENPI_RPC_HOST_WATCH_FD",
	"SENPI_RPC_HOST_WATCH_PPID",
	"SENPI_RPC_HOST_WATCH_PSTART",
	"SENPI_RPC_HOST_WATCH_PSTART_TICKS",
	"SENPI_RPC_HOST_SCRATCH_DIR",
	"SENPI_RPC_HOST_CLEANUP_PATHS",
	"SENPI_RPC_HOST_PUBLIC_SOCKET",
	"SENPI_RPC_HOST_DAEMON_DIR",
	"SENPI_RPC_HOST_INSTANCE_ID",
	"SENPI_RPC_HOST_GENERATION",
	"SENPI_RPC_HOST_EXPECTED_RUNTIME_BUILD_ID",
] as const;

// Names that must pass through byte-for-byte: user tunables in the same namespace, TLS trust, and a plain variable.
const KEEP = {
	SENPI_RPC_HOST_IDLE_EXIT_MS: "keep-idle",
	SENPI_RPC_HOST_REAPER: "keep-reaper",
	SENPI_RPC_SESSION_IDLE_EVICTION_MS: "keep-eviction",
	SSL_CERT_FILE: "/synthetic/ca.pem",
	ISSUE_5635_UNRELATED: "keep-unrelated",
} as const;

function stubHostEnvironment(): void {
	for (const name of HANDOFF) vi.stubEnv(name, name === "SENPI_RPC_INTERNAL_KEY_STDIN" ? "1" : `synthetic-${name}`);
	for (const [name, value] of Object.entries(KEEP)) vi.stubEnv(name, value);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("issue #5635 agent shells never carry the host's supervisor hand-off", () => {
	it.each([
		["getShellEnv", getShellEnv],
		["getUserShellEnv", getUserShellEnv],
	])("%s drops every hand-off name and keeps everything else", (_label, build) => {
		// Given: this process is an RPC host child holding its hand-off.
		stubHostEnvironment();

		// When: an agent shell environment is built.
		const env = build();

		// Then: no hand-off name survives, every other name is untouched, and the host itself still holds them.
		expect(HANDOFF.filter((name) => name in env)).toEqual([]);
		for (const [name, value] of Object.entries(KEEP)) expect(env[name]).toBe(value);
		expect(env.HOME).toBe(process.env.HOME);
		expect(env.SENPI_RPC_ORIGIN_HOST_INSTANCE).toBe("synthetic-SENPI_RPC_HOST_INSTANCE_ID");
		expect(HANDOFF.filter((name) => process.env[name] === undefined)).toEqual([]);
	});

	it("a senpi CLI started from an agent shell boots instead of waiting for an internal key", () => {
		// Given: the host child's env, with no key on the CLI's stdin.
		stubHostEnvironment();
		const cliMain = fileURLToPath(new URL("../../../src/cli-main.ts", import.meta.url));

		// When: the agent shell (built the way the bash tool builds it) starts the CLI.
		const child = spawnSync("sh", ["-c", '"$0" "$1" --version', process.execPath, cliMain], {
			env: getShellEnv(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Then: the CLI starts normally.
		expect(child.error).toBeUndefined();
		expect(child.stderr).not.toContain("internal_key_unavailable");
		expect(child.status).toBe(0);
		expect(child.stdout.trim()).not.toBe("");
	});
});
