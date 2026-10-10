// Runs one grandparent.cjs shape through the bash tool's real shell operations from a CONSOLE-LESS parent
// (an IDE- or GUI-launched host), then reports whether the node grandparent and its child own a visible
// console window. argv: <inherit|detached|shell> [control]. "control" spawns the same shell without windowsHide,
// proving the probe can see a console when one exists. Prints one JSON line; the test owns the assertion.
import { dlopen, FFIType } from "bun:ffi";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations } from "../../../src/core/tools/bash.ts";
import { getShellConfig } from "../../../src/utils/shell.ts";

const PID_FILE_DEADLINE_MS = 30_000;
const shape = process.argv[2] ?? "";
if (!["inherit", "detached", "shell", "firebase-java", "firebase-shell"].includes(shape))
	throw new Error(`unknown shape ${shape}`);
const control = process.argv[3] === "control";

const grandparentPath = fileURLToPath(new URL("./grandparent.cjs", import.meta.url)).replaceAll("\\", "/");
const attachmentProbePath = fileURLToPath(new URL("./attachment-probe.ts", import.meta.url));

function detachCurrentConsole(): void {
	dlopen("kernel32.dll", { FreeConsole: { args: [], returns: FFIType.i32 } }).symbols.FreeConsole();
}

function attachment(pid: number): unknown {
	const result = spawnSync(process.execPath, [attachmentProbePath, String(pid)], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`attachment probe failed for ${pid}: ${result.stderr.trim()}`);
	return JSON.parse(result.stdout.trim());
}

function killTree(pid: number): void {
	spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

async function waitForFile(path: string): Promise<string> {
	const deadline = Date.now() + PID_FILE_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const text = readFileSync(path, "utf8").trim();
			if (text.length > 0) return text;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`the bash-tool command never wrote ${path} within ${PID_FILE_DEADLINE_MS}ms`);
}

detachCurrentConsole();
const dir = mkdtempSync(join(tmpdir(), "senpi-console-probe-"));
const pidFile = join(dir, "pids.json").replaceAll("\\", "/");
const leafPidFile = join(dir, "leaf.pid").replaceAll("\\", "/");
const controller = new AbortController();
const command = `node '${grandparentPath}' ${shape} '${pidFile}' '${leafPidFile}'`;
const run: Promise<unknown> = control ? spawnWithoutHide(command) : spawnThroughBashTool(command);

function spawnThroughBashTool(cmd: string): Promise<unknown> {
	return createLocalBashOperations()
		.exec(cmd, dir, { onData: () => {}, signal: controller.signal, timeout: 60 })
		.catch(() => undefined);
}

function spawnWithoutHide(cmd: string): Promise<unknown> {
	const shell = getShellConfig();
	const viaStdin = shell.commandTransport === "stdin";
	const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, cmd], {
		cwd: dir,
		stdio: [viaStdin ? "pipe" : "ignore", "ignore", "ignore"],
		signal: controller.signal,
	});
	if (viaStdin) child.stdin?.end(cmd);
	return new Promise((resolve) => {
		child.once("close", resolve);
		child.once("error", resolve);
	});
}
let pids: { grandparent: number; grandchild: number; leaf: number } | undefined;
try {
	const chain = JSON.parse(await waitForFile(pidFile)) as { grandparent: number; grandchild: number };
	pids = { ...chain, leaf: Number.parseInt(await waitForFile(leafPidFile), 10) };
	process.stdout.write(
		`${JSON.stringify({ shape, control, grandparent: attachment(pids.grandparent), grandchild: attachment(pids.grandchild), leaf: attachment(pids.leaf) })}\n`,
	);
} finally {
	controller.abort();
	if (pids) {
		killTree(pids.leaf);
		killTree(pids.grandchild);
		killTree(pids.grandparent);
	}
	await run;
	rmSync(dir, { recursive: true, force: true });
}
