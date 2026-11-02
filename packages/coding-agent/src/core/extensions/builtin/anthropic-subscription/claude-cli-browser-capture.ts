import {
	type FSWatcher,
	chmodSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../../../../config.ts";
import { createSessionLogger } from "../../../session-log.ts";

/**
 * The `BROWSER` helper of one login. `capture` appends the URL the CLI wants to open to a private sink, so senpi can
 * hand it to the client (the desktop opens it on the user's machine); `discard` swallows it for copy-code login.
 * The helper runs nothing but that one write.
 */
export type ClaudeCliBrowserCapture = {
	readonly helperPath: string;
	/** Reads any URL written since the last call; also runs on every sink change. */
	readonly flush: () => void;
	readonly dispose: () => void;
};

function shSingleQuoted(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function helperScript(mode: "capture" | "discard", sinkPath: string, platform: NodeJS.Platform): string {
	if (platform === "win32") {
		// Delayed expansion keeps `&` and `?` in the URL literal; `echo(` prints even an empty argument. The CLI starts
		// the helper in its own cwd (the account dir) and does not wait for it; Windows cannot delete a directory that a
		// live process has as its cwd, so the helper leaves it before setlocal. The implicit endlocal restores %SystemRoot%,
		// and the helper never holds the account dir after senpi sees the URL (senpi#4654).
		return mode === "discard"
			? "@exit /b 0\r\n"
			: `@echo off\r\ncd /d "%SystemRoot%"\r\nsetlocal EnableDelayedExpansion\r\nset "u=%~1"\r\n>>"${sinkPath}" echo(!u!\r\n`;
	}
	return mode === "discard"
		? "#!/bin/sh\nexit 0\n"
		: `#!/bin/sh\nprintf '%s\\n' "$1" >> ${shSingleQuoted(sinkPath)}\n`;
}

export function createClaudeCliBrowserCapture(
	mode: "capture" | "discard",
	onUrl: (url: string) => void,
	platform: NodeJS.Platform = process.platform,
): ClaudeCliBrowserCapture {
	const logger = createSessionLogger(getAgentDir());
	const dir = mkdtempSync(join(tmpdir(), "senpi-claude-browser-"));
	const sinkPath = join(dir, "urls");
	const helperPath = join(dir, platform === "win32" ? "browser.cmd" : "browser");
	writeFileSync(helperPath, helperScript(mode, sinkPath, platform), { mode: 0o700 });
	chmodSync(helperPath, 0o700);

	let consumed = 0;
	const flush = () => {
		let text: string;
		try {
			text = readFileSync(sinkPath, "utf8");
		} catch {
			return; // nothing written yet
		}
		const complete = text.slice(0, text.lastIndexOf("\n") + 1);
		const lines = complete.split(/\r?\n/).filter((line) => line.trim().length > 0);
		for (const line of lines.slice(consumed)) onUrl(line.trim());
		consumed = lines.length;
	};
	let watcher: FSWatcher | undefined;
	if (mode === "capture") {
		watcher = watch(dir, flush);
		watcher.on("error", () => watcher?.close());
	}
	return {
		helperPath,
		flush,
		dispose: () => {
			watcher?.close();
			let cleanupDir = dir;
			try {
				// A browser helper can outlive the CLI even after its stdio closes. Revoke its
				// absolute sink path before deletion: late opens fail, already-open files unlink safely.
				const disposedDir = `${dir}-disposed`;
				renameSync(dir, disposedDir);
				cleanupDir = disposedDir;
			} catch {
				logger.debug("claude_cli_browser_capture_rename_failed", { source: dir });
			}
			try {
				rmSync(cleanupDir, { recursive: true, force: true, maxRetries: 3 });
			} catch {
				// Private scratch cleanup must never prevent the login outcome from settling.
				logger.debug("claude_cli_browser_capture_cleanup_failed", { source: cleanupDir });
			}
		},
	};
}
