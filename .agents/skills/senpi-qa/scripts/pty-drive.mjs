/**
 * senpi-qa Channel 5 — persistent-terminal (PTY) drive.
 *
 * Drives the real @earendil-works/pi-pty runtime that backs the builtin `terminal`
 * extension tools (bash / bash_output / bash_input / bash_resize / kill_bash) through
 * the canonical persistent-session scenarios, in an isolated sandbox, asserting the
 * real auth.json sha256 is unchanged. A pass is evidence the terminal runtime works
 * end-to-end on this OS. Native PTY is used when a host prebuild is present; otherwise
 * the loader falls back to the child_process pipe backend (still exercised here).
 *
 * Usage:
 *   node pty-drive.mjs --self-test [--evidence SLUG]
 *   node pty-drive.mjs --self-test --force-pipe        # force the pipe fallback backend
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks } from "./lib/common.mjs";

const argv = process.argv.slice(2);
if (argv[0] !== "--self-test") {
	process.stdout.write(
		[
			"senpi-qa Channel 5 — persistent-terminal (PTY) drive",
			"  node pty-drive.mjs --self-test [--evidence SLUG] [--force-pipe]",
			"",
		].join("\n"),
	);
	process.exit(0);
}

const evidenceIdx = argv.indexOf("--evidence");
const slug = evidenceIdx >= 0 ? argv[evidenceIdx + 1] : undefined;
if (argv.includes("--force-pipe")) process.env.SENPI_PTY_FORCE_PIPE = "1";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Await a session exit but never block the harness longer than `timeoutMs`. */
async function waitExitBounded(session, timeoutMs = 4000) {
	await Promise.race([session.waitExit(), delay(timeoutMs)]);
}

async function waitForText(session, needle, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	let buffer = "";
	const unsubscribe = session.onData((chunk) => {
		buffer += Buffer.from(chunk).toString("utf-8");
	});
	try {
		while (Date.now() < deadline) {
			if (buffer.includes(needle)) return buffer;
			if (session.exited) return buffer.includes(needle) ? buffer : null;
			await delay(50);
		}
		return null;
	} finally {
		unsubscribe();
	}
}

async function main() {
	const auth = guardRealAuth();
	installCleanupHooks();
	const checks = createChecks("pty-drive self-test");
	const log = [];
	const record = (line) => {
		log.push(line);
		process.stderr.write(`${line}\n`);
	};

	const { createTerminalSession, TerminalScreen, SessionRegistry } = await import("@earendil-works/pi-pty");

	// Scenario A — background command + wait_for output.
	const shell = process.platform === "win32" ? "bash" : "/bin/bash";
	const a = createTerminalSession({ command: shell, args: ["-c", "sleep 0.3; echo READY_MARK"], cols: 120, rows: 40 });
	record(`backend: ${a.backend}`);
	const seen = await waitForText(a, "READY_MARK");
	checks.ok("A: wait_for sees READY_MARK", seen !== null);
	await waitExitBounded(a);

	// Scenario B — interactive session steering via stdin. `cat` echoes each line back,
	// proving bash_input reaches a live child, then exits cleanly on ctrl-d / kill.
	const b = createTerminalSession({ command: "cat", args: [], cols: 120, rows: 40 });
	await delay(150);
	b.write("STEER_42\n");
	const steered = await waitForText(b, "STEER_42", 4000);
	checks.ok("B: bash_input steers a live session (STEER_42)", steered !== null);
	b.write("\x04"); // ctrl-d closes cat's stdin
	b.kill();
	await waitExitBounded(b);

	// Scenario C — screen model + resize reflow.
	const screen = new TerminalScreen({ cols: 80, rows: 24 });
	await screen.feed("hello-screen\r\n");
	const snap1 = screen.snapshot();
	checks.ok("C: screen snapshot captures output", snap1.visibleGrid.join("\n").includes("hello-screen"));
	await screen.resize(100, 30);
	const snap2 = screen.snapshot();
	checks.ok("C: resize reflows to 100x30", snap2.cols === 100 && snap2.rows === 30);
	screen.dispose();

	// Scenario D — registry teardown leaves no tracked session.
	const registry = new SessionRegistry({
		createSession: () => createTerminalSession({ command: shell, args: ["-c", "sleep 30"], cols: 80, rows: 24 }),
	});
	const entry = await registry.create({ command: "bash" });
	checks.ok("D: registry tracks the live session", registry.size === 1);
	await registry.teardown();
	checks.ok("D: teardown removes all sessions (no orphans)", registry.size === 0);

	auth.assertUnchanged();
	checks.ok("auth.json sha256 unchanged", true);

	if (slug) {
		const dir = evidenceDir(slug);
		writeFileSync(join(dir, "pty-drive.txt"), log.join("\n"));
		process.stderr.write(`evidence: ${dir}\n`);
	}
	process.exit(checks.finish() ? 0 : 1);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
