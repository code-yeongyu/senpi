// senpi#5635: the scrub keeps the hand-off out of agent children, but the ONE process meant to read the internal key
// still gets it. A supervisor started from a scrubbed agent shell (no sentinel of its own) spawns its host child through
// the real spawnHostChild, and that child's real bootstrap reads the key from stdin.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { childEnvironmentOf } from "../../../src/modes/rpc/host-identity-env.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";

const fixture = fileURLToPath(new URL("./fixtures/issue-5635-supervised-host-key.ts", import.meta.url));

function reportOf(stderr: string, tag: string): unknown {
	const line = stderr.split("\n").find((entry) => entry.startsWith(`${tag} `));
	return line === undefined ? undefined : JSON.parse(line.slice(tag.length + 1));
}

describe.skipIf(process.platform === "win32")("issue #5635 the legitimate key reader still gets its key", () => {
	it("a supervisor started from a scrubbed agent shell hands its host child the key, and the child reads it", async () => {
		// Given: an agent shell env built from a host that holds its hand-off.
		const shellEnv = childEnvironmentOf({
			...hostSpawnEnv(),
			SENPI_RPC_INTERNAL_KEY_STDIN: "1",
			SENPI_RPC_HOST_INSTANCE_ID: "outer-host",
		});

		// When: a lifecycle supervisor runs from that shell and starts its host child.
		const child = spawn("bun", [fixture, "supervisor"], { env: shellEnv, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (data) => {
			stderr += String(data);
		});
		const [code] = await new Promise<[number | null]>((resolve) => child.once("close", (exit) => resolve([exit])));

		// Then: the supervisor inherited no sentinel, yet its host child read the key it was handed.
		expect(reportOf(stderr, "SUPERVISOR_REPORT")).toEqual({ sentinelInherited: false });
		expect(reportOf(stderr, "HOST_REPORT")).toEqual({ booted: true, keyMatches: true, sentinelLeft: false });
		expect(code).toBe(0);
	});
});
