import fs from "node:fs";

// A worker thread shares the host process's fd 0, which in interactive mode is the TUI's terminal.
// A cell reading it (fs.readFileSync(0 | "/dev/stdin"), Bun.stdin, Bun.file("/dev/stdin")) blocks on the
// user's keyboard and, because a timed-out cell's worker is replaced rather than stopped, the abandoned
// read keeps consuming every key typed into the TUI. Cells read /dev/null instead and see EOF at once.
const NULL_DEVICE = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";
const STDIN_PATHS = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);

function isHostStdin(target) {
	return target === 0 || (typeof target === "string" && STDIN_PATHS.has(target)) || (target instanceof URL && STDIN_PATHS.has(target.pathname));
}

function redirect(original, owner) {
	return function (target, ...rest) {
		return original.call(owner, isHostStdin(target) ? NULL_DEVICE : target, ...rest);
	};
}

export function installStdinGuard() {
	const patched = [
		[fs, "readFileSync"],
		[fs, "readFile"],
		[fs, "openSync"],
		[fs, "open"],
		[fs, "createReadStream"],
		[fs.promises, "readFile"],
		[fs.promises, "open"],
	].map(([owner, name]) => {
		const original = owner[name];
		owner[name] = redirect(original, owner);
		return () => {
			owner[name] = original;
		};
	});
	const bun = globalThis.Bun;
	if (bun !== null && typeof bun === "object" && typeof bun.file === "function") {
		const originalFile = bun.file;
		const originalStdin = bun.stdin;
		bun.file = redirect(originalFile, bun);
		bun.stdin = originalFile.call(bun, NULL_DEVICE);
		patched.push(() => {
			bun.file = originalFile;
			bun.stdin = originalStdin;
		});
	}
	return () => {
		for (const restore of patched) restore();
	};
}
