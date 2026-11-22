/**
 * A stand-in for a lifecycle supervisor: it spawns ONE child that the sandbox path never names
 * (its argv carries no sandbox directory), prints that child's pid, and then idles.
 *
 * Killing this process re-parents the child, which is exactly how a real supervisor's host child
 * escapes a teardown that kills before it looks (senpi test teardown ordering).
 */
import { spawn } from "node:child_process";

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
	detached: false,
	stdio: "ignore",
});
process.stdout.write(`${JSON.stringify({ grandchild: grandchild.pid })}\n`);
setInterval(() => {}, 1 << 30);
