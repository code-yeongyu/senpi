/**
 * Regression #2815: while the interactive TUI owns the terminal, nothing but the renderer may write
 * to it. A raw fd 1 write, a child inheriting stdout, or Bun's native console.log scrolled the real
 * terminal behind the renderer and pushed the editor below the screen. fd 1 now goes to the debug
 * log like fd 2 (#2284), and the renderer draws through a duplicate of the terminal.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../../../src/config.ts";
import { capHiddenOutputLog } from "../../../src/modes/interactive/interactive-stderr-guard.ts";

const guardModule = fileURLToPath(
	new URL("../../../src/modes/interactive/interactive-stderr-guard.ts", import.meta.url),
);
const bashToolModule = fileURLToPath(new URL("../../../src/core/tools/bash.ts", import.meta.url));
const modeModule = fileURLToPath(new URL("../../../src/modes/interactive/interactive-mode.ts", import.meta.url));
const originalAgentDir = process.env[ENV_AGENT_DIR];
const tempDirs: string[] = [];

function useTempAgentDir(slug: string): string {
	const agentDir = mkdtempSync(join(tmpdir(), `senpi-2815-${slug}-`));
	tempDirs.push(agentDir);
	process.env[ENV_AGENT_DIR] = agentDir;
	return agentDir;
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** Runs `bun <fixture>` with a real terminal on fd 0-2 (script(1)), returning what the terminal showed. */
function runOnTerminal(fixturePath: string, agentDir: string) {
	const command = `bun ${JSON.stringify(fixturePath)}`;
	const args =
		process.platform === "darwin" ? ["-q", "/dev/null", "bun", fixturePath] : ["-qec", command, "/dev/null"];
	return spawnSync("script", args, {
		env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
}

function fixture(agentDir: string, name: string, lines: string[]): string {
	const path = join(agentDir, name);
	writeFileSync(path, lines.join("\n"));
	return path;
}

describe.skipIf(process.platform === "win32")("#2815 fd-level stdout capture under Bun", () => {
	test("raw fd 1 writes, inherited-stdout children and native console.log go to the debug log; the renderer still reaches the terminal", () => {
		const agentDir = useTempAgentDir("fd1");
		const path = fixture(agentDir, "fixture.ts", [
			"import { writeSync } from 'node:fs';",
			`import { prepareInteractiveStderrCapture, restoreInteractiveStderr, takeOverInteractiveStderr } from ${JSON.stringify(guardModule)};`,
			"await prepareInteractiveStderrCapture();",
			"takeOverInteractiveStderr();",
			"writeSync(1, 'native-out\\n');",
			"await Bun.spawn(['/bin/sh', '-c', 'echo child-out'], { stdout: 'inherit', stderr: 'ignore' }).exited;",
			"console.log('console-out');",
			"process.stdout.write('renderer-frame cols=' + process.stdout.columns + '\\n');",
			"restoreInteractiveStderr();",
			"writeSync(1, 'after-restore\\n');",
		]);

		const result = runOnTerminal(path, agentDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/renderer-frame cols=\d+/);
		expect(result.stdout).not.toContain("renderer-frame cols=undefined");
		expect(result.stdout).toContain("after-restore");
		for (const stray of ["native-out", "child-out", "console-out"]) expect(result.stdout).not.toContain(stray);
		const log = readFileSync(getDebugLogPath(), "utf8");
		for (const stray of ["native-out", "child-out", "console-out"]) expect(log).toContain(stray);
		expect(log).not.toContain("renderer-frame");
		expect(log).not.toContain("after-restore");
	});

	test("a piped stdout is a protocol, not a screen: print, json and rpc output stays on fd 1", () => {
		const agentDir = useTempAgentDir("pipe");
		const path = fixture(agentDir, "fixture.ts", [
			"import { writeSync } from 'node:fs';",
			`import { prepareInteractiveStderrCapture, restoreInteractiveStderr, takeOverInteractiveStderr } from ${JSON.stringify(guardModule)};`,
			"await prepareInteractiveStderrCapture();",
			"takeOverInteractiveStderr();",
			'writeSync(1, \'{"type":"protocol-line"}\\n\');',
			"await Bun.spawn(['/bin/sh', '-c', 'echo child-protocol-line'], { stdout: 'inherit', stderr: 'ignore' }).exited;",
			"restoreInteractiveStderr();",
		]);

		const result = spawnSync("bun", [path], {
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('{"type":"protocol-line"}');
		expect(result.stdout).toContain("child-protocol-line");
	});

	test("the bash tool still captures its command's output through its pipe", () => {
		const agentDir = useTempAgentDir("bash");
		const path = fixture(agentDir, "fixture.ts", [
			`import { prepareInteractiveStderrCapture, restoreInteractiveStderr, takeOverInteractiveStderr } from ${JSON.stringify(guardModule)};`,
			`import { createBashTool } from ${JSON.stringify(bashToolModule)};`,
			"await prepareInteractiveStderrCapture();",
			"takeOverInteractiveStderr();",
			"const result = await createBashTool(process.cwd()).execute('call-1', { command: 'echo captured-by-tool' });",
			"const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');",
			"process.stdout.write('TOOL-RESULT ' + text.trim() + '\\n');",
			"restoreInteractiveStderr();",
		]);

		const result = runOnTerminal(path, agentDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("TOOL-RESULT captured-by-tool");
	});

	test("the crash path hands fd 1 back before the process exits", () => {
		const agentDir = useTempAgentDir("crash");
		const path = fixture(agentDir, "fixture.ts", [
			"import { writeSync } from 'node:fs';",
			`import { prepareInteractiveStderrCapture, takeOverInteractiveStderr } from ${JSON.stringify(guardModule)};`,
			`import { InteractiveMode } from ${JSON.stringify(modeModule)};`,
			"await prepareInteractiveStderrCapture();",
			"takeOverInteractiveStderr();",
			"writeSync(1, 'hidden-before-crash\\n');",
			"process.on('exit', () => writeSync(1, 'fd1-after-crash\\n'));",
			"const context = { isShuttingDown: false, showWarning() {}, ui: { stop() {} }, pauseQuestionMouseCapture() {}, unregisterSignalHandlers() {} };",
			"InteractiveMode.prototype.uncaughtCrash.call(context, new Error('qa crash'), 'uncaughtException');",
		]);

		const result = runOnTerminal(path, agentDir);

		expect(result.stdout).toContain("fd1-after-crash");
		expect(result.stdout).toContain("qa crash");
		expect(result.stdout).not.toContain("hidden-before-crash");
		expect(readFileSync(getDebugLogPath(), "utf8")).toContain("hidden-before-crash");
	});

	test("/keybindings hands the terminal back before its editor runs, so the editor is visible, not drawn into the log", () => {
		const agentDir = useTempAgentDir("keybindings");
		const editorPath = join(agentDir, "fake-editor.sh");
		writeFileSync(editorPath, "#!/bin/sh\necho editor-visible\nexit 0\n", { mode: 0o755 });
		const path = fixture(agentDir, "fixture.ts", [
			`import { prepareInteractiveStderrCapture, restoreInteractiveStderr, takeOverInteractiveStderr } from ${JSON.stringify(guardModule)};`,
			`import { InteractiveMode } from ${JSON.stringify(modeModule)};`,
			"await prepareInteractiveStderrCapture();",
			"takeOverInteractiveStderr();",
			"const calls = [];",
			"const context = Object.assign(Object.create(InteractiveMode.prototype), {",
			"  keybindings: { getEffectiveConfig: () => ({}), reload() {} },",
			"  showError: (message) => calls.push('error ' + message),",
			"  showStatus: (message) => calls.push('status ' + message),",
			"  pauseQuestionMouseCapture() {}, resumeQuestionMouseCapture() {},",
			"  ui: { stop: () => calls.push('ui-stop'), start: () => calls.push('ui-start'), requestRender() {} },",
			"});",
			"await context.handleKeybindingsCommand();",
			"restoreInteractiveStderr();",
			"process.stdout.write('CALLS ' + calls.join(',') + '\\n');",
		]);

		const result = spawnSync(
			"script",
			process.platform === "darwin"
				? ["-q", "/dev/null", "bun", path]
				: ["-qec", `bun ${JSON.stringify(path)}`, "/dev/null"],
			{
				env: { ...process.env, [ENV_AGENT_DIR]: agentDir, VISUAL: editorPath, EDITOR: editorPath },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 60_000,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("editor-visible");
		expect(result.stdout).toContain("CALLS ui-stop,ui-start,status Keybindings reloaded");
		expect(readFileSync(getDebugLogPath(), "utf8")).not.toContain("editor-visible");
	});
});

describe("#2815 hidden output stays bounded", () => {
	test("a log past the cap is cut back to its most recent tail behind one marker", () => {
		const agentDir = useTempAgentDir("cap");
		const logPath = join(agentDir, "debug.log");
		writeFileSync(logPath, `${"old ".repeat(300_000)}recent-tail-marker\n`);

		expect(capHiddenOutputLog(logPath, 512 * 1024)).toBe(true);

		const log = readFileSync(logPath, "utf8");
		expect(log.length).toBeLessThan(512 * 1024);
		expect(log).toContain("debug log cut at");
		expect(log).toContain("recent-tail-marker");
		expect(capHiddenOutputLog(logPath, 512 * 1024)).toBe(false);
	});
});
