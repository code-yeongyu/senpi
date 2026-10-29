// This module must be the first import in every worker. No builtin ESM namespace exists yet.
import { installFilesystemPermissions } from "./interpose-fs.js";
import { installProcessPermissions } from "./interpose-process.js";
import { installBunPermissions } from "./interpose-bun.js";
import { installSqlitePermissions } from "./interpose-sqlite.js";
import { installModulePermissions } from "./interpose-modules.js";
import { installCapabilityPermissions } from "./interpose-capabilities.js";
import { checkPath } from "./interpose-paths.js";

// Bootstrap is engine-owned; there is no user statement until this one-time handoff finishes.
let check = () => {};
let engineDepth = 0;
const authorize = (operation) => { if (engineDepth === 0) return check(operation); };
const fs = process.getBuiltinModule("node:fs");
const workerThreads = process.getBuiltinModule("node:worker_threads");
const bootstrap = workerThreads.workerData;
// Restore the public value before any builtin namespace or user preload observes it.
if (bootstrap.script) workerThreads.workerData = bootstrap.userWorkerData;
// Bun gives each worker one ESM namespace per builtin, copied from the module object at its first
// import and never refreshed, so the guarded constructor must be in place before that import. Only a
// user worker started under an active token is enforced against for its whole life, so only it gets
// the forwarder; every other context keeps the engine's own Worker on the module.
let guardedWorker;
let forwarder;
if (bootstrap.script && bootstrap.enforced) {
	// A function, not a class: it hands back the instance the guarded class builds for new.target.
	forwarder = function Worker(...args) {
		if (!new.target) throw new TypeError("Class constructor Worker cannot be invoked without 'new'");
		if (!guardedWorker) throw new Error("Worker is unavailable until the permission runtime starts");
		return Reflect.construct(guardedWorker, args, new.target);
	};
	Object.setPrototypeOf(forwarder.prototype, EventTarget.prototype);
	Object.defineProperty(workerThreads, "Worker", { value: forwarder, writable: false, configurable: false, enumerable: true });
}
const installGuardedWorker = (Guarded) => {
	if (!forwarder) {
		globalThis.Worker = Guarded;
		return;
	}
	guardedWorker = Guarded;
	Object.setPrototypeOf(forwarder.prototype, Guarded.prototype);
	globalThis.Worker = forwarder;
};
const originals = { ...fs.promises, readFileSync: fs.readFileSync, realpathSync: fs.realpathSync };
const execFile = process.getBuiltinModule("node:child_process").execFile;
const cleanupExecFile = (...args) => {
	engineDepth++;
	try { return execFile(...args); }
	finally { engineDepth--; }
};
const { dirname } = process.getBuiltinModule("node:path");
const permissionIO = {
	read(raw, actual) { checkPath(authorize, "read", raw, { executed: actual }); return originals.readFile(actual, "utf8"); },
	async write(raw, actual, data) {
		checkPath(authorize, "write", raw, { executed: actual });
		await originals.mkdir(dirname(actual), { recursive: true });
		await originals.writeFile(actual, data);
	},
};
const resources = installFilesystemPermissions(authorize);
installProcessPermissions(authorize, installBunPermissions(authorize, resources));
installSqlitePermissions(authorize);
const sealModules = installModulePermissions(authorize, Boolean(bootstrap.script));

// The sole bootstrap handoff is consumed before user code. Neither module exports the originals.
const { initializePermissionRuntime } = await import("./permission-runtime.js");
let runtimeAuthorize;
let activated = false;
const activate = () => {
	if (activated) return;
	activated = true;
	check = runtimeAuthorize;
	sealModules();
	installCapabilityPermissions(authorize);
};
// The worker bootstrap and the engine hooks are separate inputs: the bootstrap carries the
// permission transport this worker must consume and delete, the engine carries the authorized IO
// the runtime hands to the cell prelude. Collapsing them into one argument drops one of the two.
await initializePermissionRuntime((authorize) => { runtimeAuthorize = authorize; }, bootstrap, {
	permissionIO,
	resolverIO: originals,
	cleanupExecFile,
	activate,
	installGuardedWorker,
});
activate();
