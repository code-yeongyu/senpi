#!/usr/bin/env node
/**
 * Arms the production host watchdog on a REAL inherited pipe (fd 3) - the exact binding the
 * lifecycle supervisor gives its host child - and reports what it observed over IPC.
 *
 * A named FIFO is not a substitute for that pipe: macOS never reports EOF for one through the
 * event loop, and reading it through the file-stream path parks a thread-pool worker in `read(2)`
 * for the process's whole life, which blocks `process.exit()`. Both properties matter to the host,
 * so the fixture uses the real thing.
 *
 * argv: <scratchDir|""> [cleanup path...]
 */
import { existsSync } from "node:fs";
import { armHostWatchdog } from "../../src/modes/rpc/host-watchdog.ts";

const [scratchArg = "", ...cleanupPaths] = process.argv.slice(2);
const scratchDir = scratchArg === "" ? undefined : scratchArg;
const sidecar = process.env.WATCHDOG_SIDECAR;

armHostWatchdog(
	{
		fd: 3,
		...(scratchDir ? { scratchDir } : {}),
		cleanupPaths,
		beforeCleanup: async () => {
			process.send?.({ type: "beforeCleanup", ...(sidecar ? { sidecarExists: existsSync(sidecar) } : {}) });
		},
	},
	(reason) => {
		process.send?.({
			type: "fired",
			reason,
			scratchExists: scratchDir ? existsSync(scratchDir) : false,
			cleanupExists: cleanupPaths.map((path) => existsSync(path)),
		});
		process.exit(0);
	},
);
process.send?.({ type: "armed" });
