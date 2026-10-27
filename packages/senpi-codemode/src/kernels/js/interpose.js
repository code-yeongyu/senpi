// This module must be the first import in every worker. No builtin ESM namespace exists yet.
const childProcess = process.getBuiltinModule("node:child_process");
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const url = process.getBuiltinModule("node:url");
const workerThreads = process.getBuiltinModule("node:worker_threads");
const bootstrap = workerThreads.workerData;
// Restore the public value before any builtin namespace or user preload observes it.
if (bootstrap.script) workerThreads.workerData = bootstrap.userWorkerData;
const originalSpawnSync = childProcess.spawnSync;
const originalWriteFileSync = fs.writeFileSync;
const bun = globalThis.Bun;
const originalBunSpawnSync = bun?.spawnSync;
let check = () => { throw new Error("Permission authority not initialized"); };
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const executionCwd = (value) => value instanceof URL ? url.fileURLToPath(value) : value ?? process.cwd();

childProcess.spawnSync = function spawnSync(...parameters) {
	check(() => {
		const [file, args, options] = parameters;
		const argv = Array.isArray(args) ? args : [];
		const opts = Array.isArray(args) || args == null ? options : args;
		const shell = opts?.shell;
		const command = shell ? [file, ...argv].join(" ") : [file, ...argv].map(quote).join(" ");
		return {
			call: { tool: "bash", input: { command }, cwd: executionCwd(opts?.cwd) },
			unsupported: typeof shell === "string" && !/^(?:sh|bash|zsh|dash)$/u.test(path.basename(shell)),
		};
	});
	return originalSpawnSync.apply(this, parameters);
};

fs.writeFileSync = function writeFileSync(file, ...args) {
	check(() => {
		const requested = file instanceof URL ? url.fileURLToPath(file) : file instanceof Uint8Array ? Buffer.from(file).toString() : file;
		return {
			call: { tool: "write", input: { path: requested }, cwd: process.cwd() },
			unsupported: typeof requested !== "string" || (file instanceof Uint8Array && !Buffer.from(requested).equals(file)),
		};
	});
	let actual = typeof file === "string" ? path.resolve(process.cwd(), file) : file;
	if (file instanceof Uint8Array && !path.isAbsolute(Buffer.from(file).toString("latin1"))) {
		actual = Buffer.concat([Buffer.from(process.cwd() + path.sep), file]);
	}
	return originalWriteFileSync.call(this, actual, ...args);
};

if (originalBunSpawnSync) {
	bun.spawnSync = function spawnSync(...parameters) {
		check(() => {
			const [first, second] = parameters;
			const argv = Array.isArray(first) ? first : first?.cmd;
			const opts = Array.isArray(first) ? second : first;
			return {
				call: { tool: "bash", input: { command: Array.isArray(argv) ? argv.map(quote).join(" ") : "" }, cwd: executionCwd(opts?.cwd) },
				unsupported: !Array.isArray(argv),
			};
		});
		return originalBunSpawnSync.apply(this, parameters);
	};
}

// The sole bootstrap handoff is consumed before user code. Neither module exports the originals.
const { initializePermissionRuntime } = await import("./permission-runtime.js");
await initializePermissionRuntime((authorize) => { check = authorize; }, bootstrap);
