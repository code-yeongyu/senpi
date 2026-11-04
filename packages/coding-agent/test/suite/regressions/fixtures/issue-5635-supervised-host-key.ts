// senpi#5635 fixture. "supervisor": a lifecycle supervisor started from an agent shell (its own env is already
// scrubbed) spawns its host child through the real spawnHostChild and hands it a synthetic key. "host": that child
// runs the real internal bootstrap and reports, by stderr line, whether it read the key. Names and booleans only.
import { writeSync } from "node:fs";
import { spawnHostChild } from "../../../../src/modes/rpc/host-lifecycle-launch.ts";

const SYNTHETIC_KEY = Buffer.alloc(32, 7);

if (process.argv[2] === "host") {
	const { getInternalHostBootstrap } = await import("../../../../src/modes/rpc/internal-bootstrap.ts");
	const bootstrap = getInternalHostBootstrap();
	writeSync(
		2,
		`HOST_REPORT ${JSON.stringify({ booted: bootstrap !== undefined, keyMatches: bootstrap?.key.equals(SYNTHETIC_KEY) ?? false, sentinelLeft: process.env.SENPI_RPC_INTERNAL_KEY_STDIN !== undefined })}\n`,
	);
	process.exit(0);
} else {
	writeSync(
		2,
		`SUPERVISOR_REPORT ${JSON.stringify({ sentinelInherited: process.env.SENPI_RPC_INTERNAL_KEY_STDIN !== undefined })}\n`,
	);
	const child = spawnHostChild({
		launch: {
			socket: "fixture",
			hostArgs: [],
			childCommand: process.execPath,
			childArgs: [import.meta.filename, "host"],
		},
		internalSocket: "fixture",
		internal: { secretPath: "unused" },
		internalKey: SYNTHETIC_KEY,
		daemonDir: "unused",
		instanceId: "fixture",
		cleanupPaths: [],
		publicSocket: "fixture",
	});
	child.once("error", () => process.exit(3));
	child.once("exit", (code) => process.exit(code ?? 3));
}
