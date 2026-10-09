import { Buffer } from "node:buffer";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";

// A worker thread cannot chdir (process.chdir throws ERR_WORKER_UNSUPPORTED_OPERATION under Node
// and Bun), so every relative path a cell used resolved against the host process directory: in a
// shared RPC host that is the host's state dir, not the session's project (omo#9371). The worker
// therefore applies the session directory to the path-taking APIs itself. Patches touch only this
// worker's module instances and globals; the host thread and its bash tool keep their own cwd.

// Indexes of the path arguments each fs function takes; `symlink`'s target stays relative to the link.
const FS_PATH_ARGS = {
	access: [0],
	appendFile: [0],
	chmod: [0],
	chown: [0],
	copyFile: [0, 1],
	cp: [0, 1],
	createReadStream: [0],
	createWriteStream: [0],
	exists: [0],
	lchmod: [0],
	lchown: [0],
	link: [0, 1],
	lstat: [0],
	lutimes: [0],
	mkdir: [0],
	mkdtemp: [0],
	open: [0],
	openAsBlob: [0],
	opendir: [0],
	readdir: [0],
	readFile: [0],
	readlink: [0],
	realpath: [0],
	rename: [0, 1],
	rm: [0],
	rmdir: [0],
	stat: [0],
	statfs: [0],
	symlink: [1],
	truncate: [0],
	unlink: [0],
	unwatchFile: [0],
	utimes: [0],
	watch: [0],
	watchFile: [0],
	writeFile: [0],
};

const CHILD_PROCESS_FILE_ARGS = ["spawn", "spawnSync", "execFile", "execFileSync", "fork"];
const CHILD_PROCESS_COMMAND_ARGS = ["exec", "execSync"];
const ASYNC_GROUP_SPAWNERS = new Set(["spawn", "fork"]);

export function installSessionCwd(cwd, options) {
	// A process-mode kernel child IS the main thread; the worker guard relaxes only for that entry.
	if (isMainThread && options?.allowMainThread !== true) {
		throw new Error("installSessionCwd must only run inside a kernel worker thread");
	}
	const root = resolve(cwd);
	const rootBytes = Buffer.from(root.endsWith(sep) ? root : `${root}${sep}`);
	// fs also takes Buffer/Uint8Array paths; a relative one gets the session root prepended as bytes,
	// so non-UTF-8 names survive. A file: URL is always absolute, so URLs pass through unchanged.
	const at = (path) => {
		if (typeof path === "string") return isAbsolute(path) ? path : resolve(root, path);
		if (path instanceof Uint8Array && !isAbsolute(Buffer.from(path).toString("latin1"))) {
			return Buffer.concat([rootBytes, path]);
		}
		return path;
	};
	process.cwd = () => root;
	const path = process.getBuiltinModule("node:path");
	const resolveFromProcess = path.resolve;
	path.resolve = (...segments) => resolveFromProcess(root, ...segments);
	patchFs(process.getBuiltinModule("node:fs"), process.getBuiltinModule("node:fs/promises"), at, root);
	patchChildProcess(process.getBuiltinModule("node:child_process"), at, root);
	patchBun(globalThis.Bun, at, root);
	syncBuiltinESMExports();
}

function patchFs(fs, promises, at, root) {
	const promiseModules = [...new Set([fs.promises, promises])];
	for (const [name, indexes] of Object.entries(FS_PATH_ARGS)) {
		replace(fs, name, (fn) => resolvingArgs(fn, indexes, at));
		replace(fs, `${name}Sync`, (fn) => resolvingArgs(fn, indexes, at));
		for (const target of promiseModules) replace(target, name, (fn) => resolvingArgs(fn, indexes, at));
	}
	replace(fs.realpath, "native", (fn) => resolvingArgs(fn, [0], at));
	replace(fs.realpathSync, "native", (fn) => resolvingArgs(fn, [0], at));
	for (const target of [fs, ...promiseModules]) {
		for (const name of ["glob", "globSync"]) replace(target, name, (fn) => withOptionsCwd(fn, () => 1, root));
	}
}

function patchChildProcess(childProcess, at, root) {
	for (const name of CHILD_PROCESS_FILE_ARGS) {
		replace(childProcess, name, (fn) => {
			// Only asynchronous spawners start a new group: a synchronous call keeps the terminal (ssh/sudo/git prompts),
			// and Bun ignores `detached` for execFile. Those calls get a notice instead (group-signal-notice.js).
			const withCwd = withOptionsCwd(fn, fileOptionsIndex, root, ASYNC_GROUP_SPAWNERS.has(name));
			return name === "fork" ? resolvingArgs(withCwd, [0], at) : withCwd;
		});
	}
	for (const name of CHILD_PROCESS_COMMAND_ARGS) replace(childProcess, name, (fn) => withOptionsCwd(fn, () => 1, root));
}

function patchBun(bun, at, root) {
	if (bun === null || typeof bun !== "object") return;
	replace(bun, "file", (fn) => resolvingArgs(fn, [0], at));
	replace(bun, "write", (fn) => resolvingArgs(fn, [0], at));
	replace(bun, "spawn", (fn) => withBunSpawnCwd(fn, root));
	replace(bun, "spawnSync", (fn) => withBunSpawnCwd(fn, root, false));
	if (typeof bun.$?.cwd === "function") bun.$.cwd(root);
	const glob = bun.Glob?.prototype;
	if (glob) {
		for (const name of ["scan", "scanSync"]) {
			replace(glob, name, (fn) =>
				function scan(options) {
					return fn.call(this, globScanOptions(options, root));
				},
			);
		}
	}
}

function replace(target, name, wrap) {
	const original = target?.[name];
	if (typeof original !== "function") return;
	target[name] = copyOwnProperties(original, wrap(original));
}

function copyOwnProperties(original, wrapped) {
	for (const key of Reflect.ownKeys(original)) {
		if (key === "length" || key === "name" || key === "prototype" || Object.hasOwn(wrapped, key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(original, key);
		if (descriptor) Object.defineProperty(wrapped, key, descriptor);
	}
	return wrapped;
}

function resolvingArgs(fn, indexes, at) {
	return function resolvingPathArguments(...args) {
		for (const index of indexes) if (index < args.length) args[index] = at(args[index]);
		return fn.apply(this, args);
	};
}

// spawn(file, args?, options?) and friends: options follow an args array, or an explicit
// undefined args slot, otherwise they sit right after the file.
function fileOptionsIndex(args) {
	return Array.isArray(args[1]) || (args[1] == null && args.length > 2) ? 2 : 1;
}

function withOptionsCwd(fn, optionsIndex, root, inOwnGroup = false) {
	const group = inOwnGroup ? ownGroup : (options) => options;
	return function withSessionCwd(...args) {
		const index = optionsIndex(args);
		const options = args[index];
		if (options === undefined || options === null) args[index] = group({ cwd: root });
		else if (typeof options === "function") args.splice(index, 0, group({ cwd: root }));
		else if (typeof options === "object") args[index] = group({ ...options, cwd: cwdFrom(options.cwd, root) });
		if (!inOwnGroup || process.platform === "win32" || (isPlainOptions(options) && options.detached !== undefined)) {
			return fn.apply(this, args);
		}
		// Bun's child_process spawns through Bun.spawn, whose child tracking skips `detached` children as ones the
		// cell keeps on purpose. While this call runs, `detached` is ours, so the child is still retired with the cell.
		const depth = globalThis[INJECTED_GROUP] ?? 0;
		globalThis[INJECTED_GROUP] = depth + 1;
		try {
			return fn.apply(this, args);
		} finally {
			globalThis[INJECTED_GROUP] = depth;
		}
	};
}

function withBunSpawnCwd(fn, root, inOwnGroup = true) {
	const group = inOwnGroup ? ownGroup : (options) => options;
	return function spawnInSessionCwd(...args) {
		const [first, second] = args;
		if (Array.isArray(first)) {
			const options = second === undefined || second === null ? {} : second;
			if (typeof options !== "object") return fn.apply(this, args);
			return fn.call(this, first, group({ ...options, cwd: cwdFrom(options.cwd, root) }), ...args.slice(2));
		}
		if (first !== null && typeof first === "object") {
			return fn.call(this, group({ ...first, cwd: cwdFrom(first.cwd, root) }), ...args.slice(1));
		}
		return fn.apply(this, args);
	};
}

// senpi#2995: a JS kernel runs inside the agent process, so a child spawned from a cell would join the agent's
// process group, and a cell that later signals that group (`kill -TERM -- -$PGID`) stops the agent itself. On
// POSIX every cell child starts its own group instead; kernel teardown still retires it by pid and descendants.
// A cell that sets `detached` itself keeps its choice. Windows is left alone: there `detached` opens a console.
export const INJECTED_GROUP = Symbol.for("senpi.kernel.injectedProcessGroup");

function isPlainOptions(value) {
	return value !== null && typeof value === "object";
}

function ownGroup(options) {
	if (process.platform === "win32" || options.detached !== undefined) return options;
	return { ...options, detached: true };
}

function globScanOptions(options, root) {
	if (options === undefined || options === null) return { cwd: root };
	if (typeof options === "string") return cwdFrom(options, root);
	if (typeof options === "object") return { ...options, cwd: cwdFrom(options.cwd, root) };
	return options;
}

function cwdFrom(cwd, root) {
	if (cwd === undefined || cwd === null) return root;
	return typeof cwd === "string" && !isAbsolute(cwd) ? resolve(root, cwd) : cwd;
}
