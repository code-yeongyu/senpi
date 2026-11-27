import { type ChildProcess, spawn } from "node:child_process";

/** How long a path under an automount trigger may take to mount and resolve before it counts as unanswered. */
const AUTOMOUNT_RESOLUTION_DEADLINE_MS = 5000;

/** Where a path under an automount trigger really leads, as a short-lived child process found it. */
export type AutomountRealpath =
	| { readonly kind: "resolved"; readonly path: string }
	| { readonly kind: "failed"; readonly code: string }
	| { readonly kind: "unanswered"; readonly reason?: "recently_unanswered" | "helper_limit" };

export interface AutomountRealpathOptions {
	readonly deadlineMs?: number;
	/** The program that prints the answer; tests stand in one that never answers. */
	readonly command?: (path: string) => { readonly command: string; readonly args: readonly string[] };
	readonly onSpawn?: (child: ChildProcess) => void;
}

// The child's whole program: `canonicalizeByOpening` (policy/filesystem.ts), synchronous, answering one JSON line. It
// runs on this process's own executable: `-e` works the same under node, bun, Electron (ELECTRON_RUN_AS_NODE) and a
// compiled senpi binary (BUN_BE_BUN), and the path arrives as the only argument.
const RESOLVER = `
const fs = require("node:fs");
const path = require("node:path");
const missing = (error) => error && (error.code === "ENOENT" || error.code === "ENOTDIR");
function canonical(filePath, links) {
	if (links > 40) throw Object.assign(new Error("too many links"), { code: "ELOOP" });
	const rest = [];
	for (let current = filePath; ; ) {
		try {
			return path.resolve(fs.realpathSync.native(current), ...rest.slice().reverse());
		} catch (error) {
			if (!missing(error)) throw error;
		}
		try {
			if (fs.lstatSync(current).isSymbolicLink()) {
				const target = path.resolve(path.dirname(current), fs.readlinkSync(current), ...rest.slice().reverse());
				return canonical(target, links + 1);
			}
		} catch (error) {
			if (!missing(error)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) return filePath;
		rest.push(path.basename(current));
		current = parent;
	}
}
let answer;
try {
	answer = { path: canonical(process.argv[1], 0) };
} catch (error) {
	answer = { code: String((error && error.code) || "EIO") };
}
process.stdout.write(JSON.stringify(answer));
`;

const resolverCommand = (path: string): { command: string; args: readonly string[] } => ({
	command: process.execPath,
	args: ["-e", RESOLVER, path],
});

function parseAnswer(text: string): AutomountRealpath {
	try {
		const answer: unknown = JSON.parse(text);
		if (typeof answer === "object" && answer !== null) {
			const path = Reflect.get(answer, "path");
			if (typeof path === "string") return { kind: "resolved", path };
			const code = Reflect.get(answer, "code");
			if (typeof code === "string") return { kind: "failed", code };
		}
	} catch {
		// A child that died before answering, or printed something else, answered nothing usable.
	}
	return { kind: "failed", code: "EIO" };
}

/**
 * Resolve `path` (symlinks followed, missing descendants appended) in a child process killed at the deadline.
 *
 * A path under an automount trigger must never reach a filesystem call in this process: an automounter that does not
 * answer keeps such a call, and the shared filesystem-pool thread it runs on, forever (senpi#7157). A child blocked the
 * same way holds only itself; it is killed at the deadline and the path is unanswered. One that answers has mounted the
 * share, so the answer is where the following I/O will really land.
 */
export function realpathOutOfProcess(path: string, options: AutomountRealpathOptions = {}): Promise<AutomountRealpath> {
	const { command, args } = (options.command ?? resolverCommand)(path);
	return new Promise((settle) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "ignore"],
			env: { BUN_BE_BUN: "1", ELECTRON_RUN_AS_NODE: "1" },
			windowsHide: true,
		});
		options.onSpawn?.(child);
		let output = "";
		const deadline = setTimeout(() => {
			child.kill("SIGKILL");
			settle({ kind: "unanswered" });
		}, options.deadlineMs ?? AUTOMOUNT_RESOLUTION_DEADLINE_MS);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(deadline);
			settle({ kind: "failed", code: error.code ?? "EIO" });
		});
		child.once("close", () => {
			clearTimeout(deadline);
			settle(parseAnswer(output));
		});
	});
}
