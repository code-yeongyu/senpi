import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// senpi#3965 — platform contract: no senpi child process may open a visible
// console window on Windows. Every win32-reachable spawn/execFile of a
// console-subsystem exe must pass `windowsHide: true`.
//
// This test is a lexical gate over the audited spawn sites. It is retained
// under the test-authoring gate's platform-contract bar: the contract it
// guards is "a Windows user running senpi from a GUI-owned process never
// sees a flashing empty console window", which no behavioral test on Linux
// can observe (windowsHide is a no-op off win32).
//
// Out of scope by design (see the PR body for the full audit table):
// unix-only commands (bash/sh, lsof, ps, tmux, tar, fd) and passthrough
// wrappers whose options object is caller-owned (gated-child-process,
// gated-bun, launch-barrier, private-fd-spawn, process-worker options.spawn).

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

type SpawnSite = {
	readonly file: string;
	/** Unique substring on (or just above) the spawn call. */
	readonly anchor: string;
	/** Lines after the anchor line to include in the options window. */
	readonly windowLines: number;
};

const WINDOWS_HIDE_SPAWNS: readonly SpawnSite[] = [
	{
		file: "packages/coding-agent/src/beta/omo-local-update-worker.ts",
		anchor: "spawn(process.execPath, workerCommandArgs(request.force), {",
		windowLines: 8,
	},
	{
		file: "packages/coding-agent/src/beta/omo-local-update.ts",
		anchor: 'detached: process.platform !== "win32",',
		windowLines: 2,
	},
	{
		file: "packages/coding-agent/src/core/exec.ts",
		anchor: "const proc = spawn(command, args, {",
		windowLines: 8,
	},
	{
		file: "packages/coding-agent/src/core/share/share-gh.ts",
		anchor: 'spawn("gh", ["gist", "create", "--filename", fileName, "-"], {',
		windowLines: 6,
	},
	{
		file: "packages/coding-agent/src/self-update-bootstrap.ts",
		anchor: 'spawn(step.command, step.args, { stdio: "inherit"',
		windowLines: 1,
	},
	{
		file: "packages/coding-agent/src/utils/open-browser.ts",
		anchor: 'spawn(cmd, args, { stdio: "ignore", detached: true',
		windowLines: 1,
	},
	{
		file: "packages/coding-agent/src/experimental/mini/server/run.ts",
		anchor: 'spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"]',
		windowLines: 1,
	},
	{
		file: "packages/coding-agent/src/experimental/mini/tui/run.ts",
		anchor: "spawn(process.execPath, [...runtimeExecArgv(), SERVER_ENTRY, socketPath, sessionsRoot], {",
		windowLines: 8,
	},
	{
		file: "packages/coding-agent/src/modes/interactive/external-editor.ts",
		anchor: "spawn(editor, [...editorArgs, filePath], {",
		windowLines: 8,
	},
	{
		file: "packages/coding-agent/src/modes/interactive/external-editor.ts",
		anchor: "spawn(editor, [...editorArgs, options.path], {",
		windowLines: 8,
	},
	{
		file: "packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/executable.ts",
		anchor: "const options: VersionProbeOptions = {",
		windowLines: 8,
	},
	{
		file: "packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/models-probe.ts",
		anchor: 'spawn(executable, ["models"], {',
		windowLines: 8,
	},
	{
		file: "packages/coding-agent/src/core/extensions/builtin/mcp/diagnose.ts",
		anchor: 'killSignal: "SIGKILL",',
		windowLines: 6,
	},
	{
		file: "packages/coding-agent/src/modes/rpc/hand-run-local-repo.ts",
		anchor: '["config", "--file", file, "--no-includes", "--list", "-z"],',
		windowLines: 3,
	},
	{
		file: "packages/senpi-codemode/src/environments/js-installer.ts",
		anchor: "const child = spawn(input.command, argv, {",
		windowLines: 10,
	},
	{
		file: "packages/senpi-codemode/src/environments/py-installer.ts",
		anchor: "const child = spawn(input.interpreter, argv, {",
		windowLines: 10,
	},
	{
		file: "packages/senpi-codemode/src/kernels/shared/subprocess-process.ts",
		anchor: "const child = nodeSpawn(request.command, [...request.args], {",
		windowLines: 10,
	},
];

function optionsWindow(site: SpawnSite): string {
	const lines = readFileSync(join(REPO_ROOT, site.file), "utf-8").split("\n");
	const anchorIndex = lines.findIndex((line) => line.includes(site.anchor));
	expect(anchorIndex, `anchor not found in ${site.file}: ${site.anchor}`).toBeGreaterThanOrEqual(0);
	return lines.slice(anchorIndex, anchorIndex + site.windowLines).join("\n");
}

describe("windowsHide on win32-reachable spawns (senpi#3965)", () => {
	it.each(WINDOWS_HIDE_SPAWNS)(
		"#given $file #when the spawn at '$anchor' runs on Windows #then its options hide the console window",
		(site) => {
			// given the audited spawn site
			// when its options object is read
			const window = optionsWindow(site);
			// then the console window is hidden
			expect(window).toContain("windowsHide: true");
		},
	);
});
