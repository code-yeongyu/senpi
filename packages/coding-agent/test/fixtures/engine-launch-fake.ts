/**
 * A stand-in engine for the launch tests: it reads a launch key the way the engine does (`readLaunchKey`),
 * writes it only to the file named by `FAKE_ENGINE_KEY_OUT` (the destination the test asserts), then reports
 * its argv and pid on stdout. `FAKE_ENGINE_SESSION` makes it print a json session header first;
 * `FAKE_ENGINE_HOLD` keeps it alive until stopped; `FAKE_ENGINE_CHILD_OUT` spawns one engine child and records
 * the private table that child receives.
 */
import { spawn } from "node:child_process";
import { existsSync, fstatSync, readlinkSync, writeFileSync } from "node:fs";
import "../../src/private-fds.ts";
import { readLaunchKey } from "../../src/cli/launch-key.ts";
import { spawnWithPrivateFds } from "../../src/private-fd-spawn.ts";

const hasProc = existsSync("/proc/self/fd");
const keySocketBefore = hasProc && existsSync("/proc/self/fd/5") ? readlinkSync("/proc/self/fd/5") : undefined;
function descriptorOpen(fd: number): boolean {
	try {
		fstatSync(fd);
		return true;
	} catch {
		return false;
	}
}
const openBeforeRead = descriptorOpen(5);
const key = process.env.FAKE_ENGINE_SKIP_KEY === "1" ? undefined : await readLaunchKey();
const closedOnReturn = openBeforeRead && !descriptorOpen(5);
const keySocket = hasProc ? keySocketBefore : descriptorOpen(5) ? "open" : "closed";
const keyOut = process.env.FAKE_ENGINE_KEY_OUT;
if (keyOut !== undefined) writeFileSync(keyOut, key ?? "", { mode: 0o600 });

const childOut = process.env.FAKE_ENGINE_CHILD_OUT;
if (childOut !== undefined) {
	const child = spawnWithPrivateFds(
		spawn,
		process.execPath,
		["-e", `require("fs").writeFileSync(${JSON.stringify(childOut)}, process.env.SENPI_PRIVATE_FDS ?? "none")`],
		{ stdio: "ignore", env: { PATH: process.env.PATH ?? "" } },
	);
	await new Promise((done) => child.once("close", done));
}

const session = process.env.FAKE_ENGINE_SESSION;
if (session !== undefined) process.stdout.write(`${JSON.stringify({ type: "session", id: session })}\n`);
process.stdout.write(
	`${JSON.stringify({ type: "fake_engine", argv: process.argv.slice(2), pid: process.pid, keySocket, closedOnReturn })}\n`,
);

if (process.env.FAKE_ENGINE_HOLD === "1") {
	process.on("SIGTERM", () => process.exit(143));
	setInterval(() => {}, 1 << 30);
} else {
	process.exitCode = Number(process.env.FAKE_ENGINE_EXIT ?? "0");
}
