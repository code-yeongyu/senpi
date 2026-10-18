// Linux only: makes this process a child subreaper (PR_SET_CHILD_SUBREAPER), then starts a busy kernel host under it
// and passes the host's output through, after reporting the host's pid. Orphaned descendants of the host are
// reparented to this process instead of to pid 1.

import { dlopen, FFIType } from "bun:ffi";
import { spawn } from "node:child_process";

const PR_SET_CHILD_SUBREAPER = 36;
const libc = dlopen("libc.so.6", {
	// Only the option and its flag are read for PR_SET_CHILD_SUBREAPER.
	prctl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
if (libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1) !== 0) throw new Error("prctl(PR_SET_CHILD_SUBREAPER) failed");

const [runtime, hostFixture] = process.argv.slice(2);
if (runtime === undefined || hostFixture === undefined) throw new Error("usage: <runtime> <host fixture>");
const host = spawn(runtime, [hostFixture, "busy"], { stdio: ["pipe", "pipe", "inherit"] });
process.stdout.write(`host ${host.pid}\n`);
host.stdout.pipe(process.stdout);
// Stays alive (and so remains the subreaper) until the test kills it.
setInterval(() => {}, 1_000);
