import { once } from "node:events";
import { spawnHostChild } from "../../../src/modes/rpc/host-lifecycle-launch.ts";

// fd 4 is /dev/null, not a presenter pipe. Losing it must not kill this supervisor.
const child = spawnHostChild({
	launch: {
		socket: "unused",
		hostArgs: [],
		presenterBootstrapFd: 4,
		childCommand: process.execPath,
		childArgs: ["-e", 'process.stdin.resume(); process.stdin.once("end", () => process.exit(0));', "--"],
	},
	internalSocket: "unused",
	internal: { secretPath: "unused" },
	daemonDir: "unused",
	instanceId: "synthetic",
	cleanupPaths: [],
	publicSocket: "unused",
});
const exited = once(child, "exit");
child.stdin?.end();
const [code] = await exited;
child.stdio[3]?.destroy();
if (code !== 0) throw new Error("Ordinary child failed");
process.stdout.write("ordinary-child-survived\n");
