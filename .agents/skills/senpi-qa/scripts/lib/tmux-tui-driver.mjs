import { execFileSync } from "node:child_process";
import { readFileSync, watch, writeFileSync } from "node:fs";
import { stripAnsi } from "./common.mjs";

export function startTmuxTui({ cwd, env, command, args, capturePath, cols, rows }) {
	const session = `senpi-qa-${process.pid}-${Date.now().toString(36)}`;
	writeFileSync(capturePath, "");
	killSession(session);
	execFileSync("tmux", [
		"new-session",
		"-d",
		"-s",
		session,
		"-x",
		String(cols),
		"-y",
		String(rows),
		"-c",
		cwd,
	]);
	execFileSync("tmux", ["pipe-pane", "-o", "-t", session, `cat >> ${shellQuote(capturePath)}`]);

	const waiters = new Set();
	const fileWatcher = watch(capturePath, () => {
		const text = stripAnsi(readFileSync(capturePath, "utf8"));
		for (const waiter of waiters) waiter.check(text);
	});
	const launchPath = `${capturePath}.launch.sh`;
	const removedKeys = Object.keys(process.env).filter((key) => !Object.hasOwn(env, key));
	const environment = Object.entries(env)
		.filter(([key, value]) => process.env[key] !== value)
		.map(([key, value]) => `export ${key}=${shellQuote(value)}`);
	writeFileSync(
		launchPath,
		[
			"#!/bin/sh",
			...removedKeys.map((key) => `unset ${key}`),
			...environment,
			`exec ${shellQuote(command)} ${args.map(shellQuote).join(" ")}`,
			"",
		].join("\n"),
	);
	execFileSync("tmux", ["send-keys", "-t", session, "-l", `exec /bin/sh ${shellQuote(launchPath)}`]);
	execFileSync("tmux", ["send-keys", "-t", session, "Enter"]);

	return {
		waitFor(predicate, label, timeoutMs = 30_000) {
			return new Promise((resolve, reject) => {
				const waiter = {
					check(text) {
						if (!predicate(text)) return;
						clearTimeout(timer);
						waiters.delete(waiter);
						resolve(text);
					},
				};
				const timer = setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error(`timed out waiting for ${label}`));
				}, timeoutMs);
				waiters.add(waiter);
				waiter.check(stripAnsi(readFileSync(capturePath, "utf8")));
			});
		},
		submit(text) {
			execFileSync("tmux", ["send-keys", "-t", session, "-l", text]);
			execFileSync("tmux", ["send-keys", "-t", session, "Enter"]);
		},
		escape() {
			execFileSync("tmux", ["send-keys", "-t", session, "Escape"]);
		},
		getRaw() {
			return readFileSync(capturePath, "utf8");
		},
		stop() {
			fileWatcher.close();
			killSession(session);
			return !hasSession(session);
		},
	};
}

function hasSession(session) {
	try {
		execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function killSession(session) {
	try {
		execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
	} catch {}
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}
