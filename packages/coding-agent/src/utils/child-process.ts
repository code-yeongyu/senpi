import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

const EXIT_STDIO_GRACE_MS = 100;
const WINDOWS_COMMAND_EXTENSIONS = [".exe", ".cmd", ".bat", ""];
const WINDOWS_COMMAND_SHIM_RE = /\.(?:cmd|bat)$/i;
const NODE_SHIM_SCRIPT_RE = /(?:%~dp0|%dp0%|%basedir%)[^"'\r\n<>|&]*?\.(?:cjs|mjs|js)/gi;

export interface ResolvedSpawnCommand {
	command: string;
	args: string[];
}

function findWindowsCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
	const candidates = extname(command)
		? [command]
		: WINDOWS_COMMAND_EXTENSIONS.map((extension) => `${command}${extension}`);
	const hasPath = command.includes("/") || command.includes("\\") || /^[a-zA-Z]:/.test(command);
	if (hasPath) {
		const match = candidates.find((candidate) => existsSync(candidate));
		return match ? resolve(match) : undefined;
	}

	const pathValue = env.PATH ?? env.Path ?? env.path;
	if (!pathValue) return undefined;
	for (const dir of pathValue.split(";")) {
		for (const candidate of candidates) {
			const path = join(dir, candidate);
			if (existsSync(path)) return resolve(path);
		}
	}
	return undefined;
}

function expandShimPath(path: string, shimPath: string): string {
	const shimDir = dirname(shimPath);
	return resolve(
		path
			.replace(/%~dp0[\\/]?/gi, `${shimDir}${sep}`)
			.replace(/%dp0%[\\/]?/gi, `${shimDir}${sep}`)
			.replace(/%basedir%[\\/]?/gi, `${shimDir}${sep}`)
			.replace(/\\/g, sep),
	);
}

function findNodeShimScript(shimPath: string): string | undefined {
	const matches = [...readFileSync(shimPath, "utf-8").matchAll(NODE_SHIM_SCRIPT_RE)];
	for (const match of matches.reverse()) {
		const scriptPath = expandShimPath(match[0], shimPath);
		if (existsSync(scriptPath)) return scriptPath;
	}
	return undefined;
}

export function resolveSpawnCommand(
	command: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv } = {},
): ResolvedSpawnCommand {
	if (process.platform !== "win32") {
		return { command, args };
	}

	const env = options.env ?? process.env;
	const resolvedCommand = findWindowsCommand(command, env);
	if (!resolvedCommand) {
		return { command, args };
	}

	if (!WINDOWS_COMMAND_SHIM_RE.test(resolvedCommand)) {
		return { command: resolvedCommand, args };
	}

	const script = findNodeShimScript(resolvedCommand);
	if (!script) {
		throw new Error(`Refusing to run Windows command shim without a shell: ${resolvedCommand}`);
	}
	const localNode = join(dirname(resolvedCommand), "node.exe");
	const nodeCommand = existsSync(localNode) ? localNode : (findWindowsCommand("node.exe", env) ?? "node");
	return { command: nodeCommand, args: [script, ...args] };
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				postExitTimer = setTimeout(() => finalize(code), EXIT_STDIO_GRACE_MS);
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
