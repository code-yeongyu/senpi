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
import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { observeFrames } from "./lib/tui-frames.mjs";
import {
	childRuntime,
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
const timeoutIndex = process.argv.indexOf("--timeout-ms");
const timeoutMs = timeoutIndex < 0 ? 60000 : Number(process.argv[timeoutIndex + 1]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");

/** Args that make the TUI boot minimal, trusted, offline, and isolated. */
function tuiArgs() {
	return ["--no-context-files", "--no-skills", "--no-extensions", "--approve"];
}

function launchArgs() {
	const root = repoRoot();
	const runtime = childRuntime();
	return {
		command: runtime.command,
		args: runtime.kind === "binary" ? tuiArgs() : runtime.kind === "bun"
			? [cliEntry(root), ...tuiArgs()]
			: [tsxEntry(root), "--tsconfig", join(root, "tsconfig.json"), cliEntry(root), ...tuiArgs()],
	};
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
	const launch = launchArgs();
	const session = `senpi-qa-tui-${process.pid}`;
	// A private server inherits the scrubbed sandbox env, not a pre-existing tmux server's env.
	// Name it with -L so the socket lives in tmux's own short dir: a socket under a long TMPDIR
	// overflows the ~104-byte Unix socket path limit. Dropping TMUX_TMPDIR pins that dir to tmux's
	// default (/tmp/tmux-<uid>) for this process and the in-session launch gate alike.
	const socketName = session;
	const env = { ...box.env };
	delete env.TMUX_TMPDIR;
	const tmux = (...args) => execFileSync("tmux", ["-L", socketName, ...args], {
		encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"],
	});
	const capture = () => {
		try {
			return tmux("capture-pane", "-t", session, "-p");
		} catch {
			return "";
		}
	};
	const alive = () => {
		try {
			tmux("has-session", "-t", session);
			return true;
		} catch {
			return false;
		}
	};

	const frames = observeFrames();
	let stream;
	let connectionTimer;
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const connected = new Promise((resolve, reject) => {
		connectionTimer = setTimeout(() => reject(new Error("TUI output pipe connection timed out")), timeoutMs);
		server.once("connection", connection => {
			clearTimeout(connectionTimer);
			stream = connection;
			stream.setEncoding("utf8");
			stream.on("data", data => frames.push(data));
			stream.on("error", error => frames.fail(error));
			stream.on("end", () => frames.fail(new Error("TUI output closed before the requested render")));
			resolve();
		});
	});
	let rendered = false;
	let acceptedInput = false;
	let survived = false;
	let screen = "";
	let renderError = "";
	try {
		const gate = `tmux -L ${shq(socketName)} wait-for start`;
		const cmd = `${gate}; exec ${shq(launch.command)} ${launch.args.map(shq).join(" ")}`;
		tmux("new-session", "-d", "-s", session, "-x", "120", "-y", "34", "-c", box.cwd, cmd);
		tmux("pipe-pane", "-O", "-t", session,
			`${shq(process.execPath)} ${shq(fileURLToPath(import.meta.url))} --forward ${server.address().port}`);
		await connected;
		// Subscribe before releasing the launch gate; the first frame cannot be missed.
		const firstFrame = frames.waitFor(text => text.trim().length > 0, "render", timeoutMs);
		tmux("wait-for", "-S", "start");
		await firstFrame;
		screen = capture();
		rendered = nonEmptyLineCount(screen) > 0;
		if (!rendered) throw new Error("TUI completed a render but tmux captured an empty screen");
		const inputFrame = frames.waitFor(text => text.includes(TYPED), "input render", timeoutMs);
		tmux("send-keys", "-t", session, "-l", TYPED);
		await inputFrame;
		screen = capture();
		acceptedInput = screen.includes(TYPED);
	} catch (error) {
		renderError = error.message;
		screen = capture();
	} finally {
		clearTimeout(connectionTimer);
		survived = alive();
		try { tmux("kill-server"); } catch {}
		stream?.destroy();
		server.close();
	}
	return { driver: "tmux", rendered, survived, acceptedInput, cleanedUp: !alive(), capture: screen, renderError };
}

/** POSIX shell single-quote escaping. */
function shq(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// node-pty driver
// ---------------------------------------------------------------------------

async function smokePty(box) {
	const launch = launchArgs();
	const pty = (await import("node-pty")).default ?? (await import("node-pty"));
	const term = pty.spawn(
		launch.command,
		launch.args,
		{ name: "xterm-color", cols: 120, rows: 34, cwd: box.cwd, env: box.env },
	);

	let buf = "";
	let exited = false;
	const frames = observeFrames();
	term.onData((d) => {
		buf += d;
		frames.push(d);
	});
	let resolveExit;
	const exit = new Promise(resolve => { resolveExit = resolve; });
	term.onExit(() => {
		exited = true;
		frames.fail(new Error("TUI exited before the requested render"));
		resolveExit();
	});

	let rendered = false;
	let acceptedInput = false;
	let renderError = "";
	try {
		await frames.waitFor(text => text.trim().length > 0, "render", timeoutMs);
		rendered = true;
		const inputFrame = frames.waitFor(text => text.includes(TYPED), "input render", timeoutMs);
		term.write(TYPED);
		await inputFrame;
		acceptedInput = true;
	} catch (error) {
		renderError = error.message;
	}
	const survived = !exited;
	try {
		term.kill();
	} catch {}
	let exitTimer;
	await Promise.race([exit, new Promise(resolve => { exitTimer = setTimeout(resolve, timeoutMs); })]);
	clearTimeout(exitTimer);

	return { driver: "pty", rendered, survived, acceptedInput, cleanedUp: exited, capture: stripAnsi(buf), renderError };
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
		return `observed completed render via ${driver}`;
	});
	checks.ok("TUI rendered a non-empty screen", !!res && res.rendered, res?.renderError);
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
if (argv[0] === "--forward") {
	const socket = connect(Number(argv[1]), "127.0.0.1");
	socket.on("error", () => process.exit(1));
	process.stdin.pipe(socket);
} else if (argv[0] === "--self-test") {
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
