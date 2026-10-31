// PTY (node-pty, or tmux on macOS) and headless-Chrome helpers shared by the eval live-block TUI scenarios.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { stripAnsi } from "../lib/common.mjs";

export function waitForCapture(term, read, predicate, timeoutMs, label) {
	return new Promise((resolveWait, rejectWait) => {
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			dataDisposable.dispose();
			exitDisposable.dispose();
			if (error) rejectWait(error);
			else resolveWait();
		};
		const inspect = () => {
			if (predicate(stripAnsi(read()))) finish();
		};
		const dataDisposable = term.onData(inspect);
		const exitDisposable = term.onExit(() => finish(new Error(`TUI exited while waiting for ${label}`)));
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), timeoutMs);
		inspect();
	});
}

export function waitForExit(term, timeoutMs) {
	return new Promise((resolveWait) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			disposable.dispose();
			resolveWait(exited);
		};
		const disposable = term.onExit(() => finish(true));
		const timer = setTimeout(() => finish(false), timeoutMs);
	});
}

export async function spawnTerminal(command, args, options) {
	// tmux pipe-pane can record nothing on some macOS hosts; SENPI_QA_PTY_DRIVER=node-pty uses node-pty there too.
	if (process.platform !== "darwin" || process.env.SENPI_QA_PTY_DRIVER === "node-pty") {
		const ptyModule = await import("node-pty");
		const pty = ptyModule.default ?? ptyModule;
		return pty.spawn(command, args, options);
	}
	const id = options.sessionName ?? `senpi-qa-eval-headline-${process.pid}`;
	const session = id;
	const startChannel = `${id}-start`;
	const exitChannel = `${id}-exit`;
	const pipePath = options.pipePath;
	writeFileSync(pipePath, "");
	const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
	const commandLine = [command, ...args].map(quote).join(" ");
	const envNames = [
		"SENPI_CODING_AGENT_DIR",
		"SENPI_CODING_AGENT_SESSION_DIR",
		"HOME",
		"USERPROFILE",
		"PI_OFFLINE",
		"PI_TELEMETRY",
		"SENPI_OMO_LOCAL_UPDATE",
		"PAGER",
		"GIT_PAGER",
		"PATH",
		"TERM",
		"COLORTERM",
	];
	const envPrefix = envNames
		.filter((name) => options.env[name] !== undefined)
		.map((name) => `${name}=${quote(options.env[name])}`)
		.join(" ");
	const shell = `tmux wait-for ${quote(startChannel)}; ${envPrefix} ${commandLine}; status=$?; tmux wait-for -S ${quote(exitChannel)}; exit $status`;
	const runTmux = (tmuxArgs, allowFailure = false) => {
		const result = spawnSync("tmux", tmuxArgs, { encoding: "utf8" });
		if (!allowFailure && result.status !== 0) {
			throw new Error(`tmux ${tmuxArgs[0]} failed: ${result.stderr || result.stdout}`);
		}
	};
	runTmux([
		"new-session",
		"-d",
		"-s",
		session,
		"-x",
		String(options.cols),
		"-y",
		String(options.rows),
		"-c",
		options.cwd,
		"/bin/sh",
		"-lc",
		shell,
	]);
	runTmux(["pipe-pane", "-O", "-t", session, `cat > ${quote(pipePath)}`]);
	const exitWaiter = spawn("tmux", ["wait-for", exitChannel], { stdio: "ignore" });
	const dataListeners = new Set();
	const exitListeners = new Set();
	let offset = 0;
	let exited = false;
	const emitNewData = () => {
		const data = readFileSync(pipePath);
		if (data.length <= offset) return;
		const chunk = data.subarray(offset).toString();
		offset = data.length;
		for (const listener of dataListeners) listener(chunk);
	};
	const watcher = watch(pipePath, emitNewData);
	exitWaiter.once("exit", (exitCode, signal) => {
		emitNewData();
		exited = true;
		for (const listener of exitListeners) listener({ exitCode: exitCode ?? 1, signal: signal ?? 0 });
	});
	runTmux(["wait-for", "-S", startChannel]);
	return {
		onData(listener) {
			dataListeners.add(listener);
			return { dispose: () => dataListeners.delete(listener) };
		},
		onExit(listener) {
			if (exited) queueMicrotask(() => listener({ exitCode: 0, signal: 0 }));
			exitListeners.add(listener);
			return { dispose: () => exitListeners.delete(listener) };
		},
		write(data) {
			if (data === "\x03\x03") {
				runTmux(["send-keys", "-t", session, "C-c", "C-c"], true);
				return;
			}
			const text = data.endsWith("\r") ? data.slice(0, -1) : data;
			if (text.length > 0) runTmux(["send-keys", "-t", session, "-l", text]);
			if (data.endsWith("\r")) runTmux(["send-keys", "-t", session, "-l", "\r"]);
		},
		kill() {
			emitNewData();
			watcher.close();
			runTmux(["kill-session", "-t", session], true);
			runTmux(["wait-for", "-S", exitChannel], true);
			exitWaiter.kill();
		},
	};
}

export function chromeExecutable() {
	const candidates = [
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter((candidate) => typeof candidate === "string");
	return candidates.find((candidate) => existsSync(candidate));
}
