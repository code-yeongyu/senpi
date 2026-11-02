#!/usr/bin/env node
/**
 * The lifecycle supervisor's own program for bundled installs (senpi#3743).
 *
 * A bundled install used to start every supervisor through `cli.js --internal-rpc-host-supervisor`,
 * which evaluates `main()`'s whole static graph (builtin extensions, provider catalog, TUI) before it
 * reaches the route: ~70 MB resident per supervisor, and the desktop runs one per opened thread. The
 * build emits this module as `dist/bundle/host-supervisor.js`, a self-contained file holding only the
 * supervisor graph (`test/supervisor-import-graph.test.ts` keeps it that way).
 *
 * Run as a program, it performs the part of the CLI preamble a supervisor relied on, in the same order:
 * the cwd guard, the process title and agent markers, silenced process warnings, and the brand read
 * before it is scrubbed so the host child inherits the same environment as before. The argv keeps the
 * `--internal-rpc-host-supervisor` sentinel, so tools that recognise a supervisor by its command line
 * still do. Imported (the import-graph probe), it does nothing.
 *
 * A supervisor started from a runtime snapshot claims that snapshot with its own pid, as `cli.js` did
 * for it: it respawns its host child through the snapshot's `cli.js`, so a prune by a later upgrade
 * must not remove the snapshot while the host child is down between two generations.
 */
import "../../valid-cwd.ts";
// Second: capture the private descriptor table before anything can spawn (senpi#4749).
import "../../private-fds.ts";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "../../config.ts";
import { brandProfile, scrubBrandFromEnvironment } from "../../core/brand.ts";
import { readRuntimeSnapshotMarker } from "../../runtime-snapshot/marker.ts";
import { claimRuntimeSnapshot, withRuntimeLock } from "../../runtime-snapshot/registry.ts";
import { findInternalSupervisorArgs, parseSupervisorArgs, runHostSupervisor } from "./host-lifecycle.ts";
import { writeStderrLine } from "./host-supervisor-log.ts";

function isEntryScript(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(import.meta.url) === realpathSync(entry);
	} catch {
		return false;
	}
}

/** Claims the snapshot this program runs from (`<snapshot>/dist/bundle/host-supervisor.js`), if it is one. */
function claimOwnRuntimeSnapshot(): void {
	try {
		const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
		if (!readRuntimeSnapshotMarker(packageDir)) return;
		withRuntimeLock(dirname(packageDir), () => claimRuntimeSnapshot(packageDir, process.pid));
	} catch {
		// no-excuse-ok: catch - like cli.js's snapshot step, the claim only adds upgrade resilience;
		// a read-only or exotic layout must never stop a supervisor from starting.
	}
}

if (isEntryScript()) {
	claimOwnRuntimeSnapshot();
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = APP_NAME;
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	brandProfile();
	scrubBrandFromEnvironment();

	const supervisorArgs = findInternalSupervisorArgs(process.argv.slice(2));
	const launch = supervisorArgs ? parseSupervisorArgs(supervisorArgs) : undefined;
	if (!launch) {
		writeStderrLine("invalid internal RPC host supervisor arguments");
		process.exit(2);
	}
	await runHostSupervisor(launch);
}
