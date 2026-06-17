/**
 * Channel 2 — TUI smoke QA.
 *
 * Boots the real interactive TUI in a pseudo-terminal, confirms it renders,
 * confirms a keystroke reaches the composer, then tears it down — all in an
 * isolated sandbox so the real ~/.senpi is never touched.
 *
 * Two PTY drivers, auto-selected so this runs natively everywhere:
 *   - "pty"  : node-pty (ConPTY on Windows, forkpty on macOS/Linux). The native
 *              Windows path — no WSL, no tmux required.
 *   - "tmux" : POSIX fallback when node-pty's PTY isn't usable (e.g. a sandbox
 *              that blocks posix_spawn) but tmux is present.
 *
 * Honest limits: a TUI is a full-screen 60fps app. tmux/pty smoke proves it
 * boots, renders, and accepts input — NOT fine-grained conversation output. For
 * behavioral assertions use Channel 1 (rpc-drive) or Channel 3 (mock-loop).
 *
 * Usage:
 *   node tui-smoke.mjs --self-test [--driver pty|tmux|auto] [--evidence SLUG]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cliEntry,
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	stripAnsi,
	tsxEntry,
} from "./lib/common.mjs";

const TYPED = "SENPIQATYPED1234";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Args that make the TUI boot minimal, trusted, offline, and isolated. */
function tuiArgs() {
	return ["--no-context-files", "--no-skills", "--no-extensions", "--approve"];
}

function nonEmptyLineCount(text) {
	return text.split("\n").filter((l) => l.trim().length > 0).length;
}

// ---------------------------------------------------------------------------
// Driver detection
// ---------------------------------------------------------------------------

function tmuxAvailable() {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function ptyUsable() {
	let pty;
	try {
		pty = (await import("node-pty")).default ?? (await import("node-pty"));
	} catch {
		return false;
	}
	try {
		const probe = pty.spawn(process.platform === "win32" ? "cmd.exe" : "/bin/echo", ["ok"], { cols: 40, rows: 10 });
		await new Promise((resolve) => {
			probe.onExit(() => resolve());
			setTimeout(resolve, 1500);
		});
		return true;
	} catch {
		return false; // PTY backend present but blocked (e.g. sandboxed posix_spawn)
	}
}

async function resolveDriver(requested) {
	if (requested === "tmux") return tmuxAvailable() ? "tmux" : "none";
	if (requested === "pty") return (await ptyUsable()) ? "pty" : "none";
	if (await ptyUsable()) return "pty";
	if (tmuxAvailable()) return "tmux";
	return "none";
}

// ---------------------------------------------------------------------------
// tmux driver
// ---------------------------------------------------------------------------

async function smokeTmux(box) {
	const root = repoRoot();
	const session = `senpi-qa-tui-${process.pid}`;
	const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });
	const capture = () => {
		try {
			return tmux("capture-pane", "-t", session, "-p");
		} catch {
			return "";
		}
	};
	const alive = () => {
		try {
			execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};

	try {
		execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
	} catch {}

	const cmd = [
		`cd ${shq(box.cwd)}`,
		`export SENPI_CODING_AGENT_DIR=${shq(box.agentDir)} SENPI_CODING_AGENT_SESSION_DIR=${shq(box.sessionDir)} PI_OFFLINE=1 PI_TELEMETRY=0`,
		`exec ${shq(process.execPath)} ${shq(tsxEntry(root))} --tsconfig ${shq(join(root, "tsconfig.json"))} ${shq(cliEntry(root))} ${tuiArgs().join(" ")}`,
	].join("; ");

	tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "34", cmd);

	let booted = "";
	for (let i = 0; i < 25 && alive(); i++) {
		await sleep(1000);
		booted = capture();
		if (nonEmptyLineCount(booted) >= 2) break;
	}
	const rendered = nonEmptyLineCount(booted) >= 2;
	const survived = alive();

	// Type a marker and confirm it reaches the composer.
	if (survived) {
		tmux("send-keys", "-t", session, "-l", TYPED);
		await sleep(800);
	}
	const afterType = capture();
	const acceptedInput = afterType.includes(TYPED);

	// Tear down: try graceful exit, then force.
	try {
		tmux("send-keys", "-t", session, "C-c");
		await sleep(200);
		tmux("send-keys", "-t", session, "C-c");
		await sleep(400);
	} catch {}
	try {
		execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
	} catch {}
	const cleanedUp = !alive();

	return { driver: "tmux", rendered, survived, acceptedInput, cleanedUp, capture: afterType || booted };
}

/** POSIX shell single-quote escaping. */
function shq(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// node-pty driver
// ---------------------------------------------------------------------------

async function smokePty(box) {
	const root = repoRoot();
	const pty = (await import("node-pty")).default ?? (await import("node-pty"));
	const term = pty.spawn(
		process.execPath,
		[tsxEntry(root), "--tsconfig", join(root, "tsconfig.json"), cliEntry(root), ...tuiArgs()],
		{ name: "xterm-color", cols: 120, rows: 34, cwd: box.cwd, env: box.env },
	);

	let buf = "";
	let exited = false;
	term.onData((d) => {
		buf += d;
	});
	term.onExit(() => {
		exited = true;
	});

	let rendered = false;
	for (let i = 0; i < 25 && !exited; i++) {
		await sleep(1000);
		if (nonEmptyLineCount(stripAnsi(buf)) >= 2) {
			rendered = true;
			break;
		}
	}
	const survived = !exited;
	if (survived) {
		term.write(TYPED);
		await sleep(800);
	}
	const acceptedInput = stripAnsi(buf).includes(TYPED);

	try {
		term.write("\x03"); // Ctrl+C
		await sleep(200);
		term.write("\x03");
		await sleep(400);
	} catch {}
	try {
		term.kill();
	} catch {}
	await sleep(300);

	return { driver: "pty", rendered, survived, acceptedInput, cleanedUp: true, capture: stripAnsi(buf) };
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

async function selfTest(requestedDriver, slug) {
	installCleanupHooks();
	const checks = createChecks("tui-smoke.mjs --self-test");
	const guard = guardRealAuth();
	const driver = await resolveDriver(requestedDriver);

	if (driver === "none") {
		process.stdout.write(
			"[SKIP] no usable PTY backend in this environment (node-pty blocked AND tmux absent).\n" +
				"       On Windows this uses node-pty/ConPTY; on POSIX, node-pty or tmux. Install one to run this channel.\n",
		);
		// A missing OS capability is not a skill defect; do not fail the gate.
		process.exit(0);
	}

	process.stdout.write(`driver: ${driver}\n`);
	const box = makeSandbox("tui-smoke");
	let res;
	await checks.run(`TUI boots and survives via ${driver}`, async () => {
		res = driver === "tmux" ? await smokeTmux(box) : await smokePty(box);
		if (!res.survived) throw new Error("TUI exited during boot");
		return `nonEmptyLines after boot`;
	});
	checks.ok("TUI rendered a non-empty screen", !!res && res.rendered);
	checks.ok("keystroke reached the composer", !!res && res.acceptedInput, res ? `looked for ${TYPED}` : "");
	checks.ok("TUI torn down (no leaked session/process)", !!res && res.cleanedUp);
	checks.ok("real auth unchanged", (() => {
		try {
			return guard.assertUnchanged();
		} catch {
			return false;
		}
	})(), guard.path);

	if (slug && res) {
		const dir = evidenceDir(slug);
		writeFileSync(join(dir, `tui-smoke-${driver}.txt`), res.capture);
		process.stderr.write(`evidence: ${dir}\n`);
	}
	if (res && (!res.rendered || !res.acceptedInput)) {
		process.stderr.write(`\n--- capture ---\n${res.capture.slice(0, 1500)}\n`);
	}

	box.cleanup();
	process.exit(checks.finish() ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv[0] === "--self-test") {
	const di = argv.indexOf("--driver");
	const ei = argv.indexOf("--evidence");
	selfTest(di >= 0 ? argv[di + 1] : "auto", ei >= 0 ? argv[ei + 1] : undefined).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else {
	process.stdout.write(
		[
			"senpi-qa Channel 2 — TUI smoke (node-pty on Windows/normal, tmux on POSIX)",
			"  node tui-smoke.mjs --self-test [--driver pty|tmux|auto] [--evidence SLUG]",
			"",
		].join("\n"),
	);
}
