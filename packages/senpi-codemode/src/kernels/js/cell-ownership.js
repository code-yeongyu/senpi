import { currentCell, onReleaseOf, settleWithCell } from "./cell-run-context.js";

// What a cell owns, and how each kind ends when the cell is stopped. Every patch is a no-op outside a cell, refuses
// (or never starts) new work for a released cell, and registers what a live cell starts so release can end it.
const RESOURCE_CLOSERS = ["terminate", "destroy", "stop", "close", "end"];

// Some host bindings are read-only (Bun.fetch); those keep their own behaviour and are not owned by cells.
function replace(owner, name, replacement, patched) {
	const original = owner[name];
	try {
		owner[name] = replacement;
	} catch {
		return;
	}
	if (owner[name] !== replacement) return;
	patched.push(() => {
		owner[name] = original;
	});
}

function builtin(name) {
	return process.getBuiltinModule?.(name);
}

function closeResource(resource) {
	for (const method of RESOURCE_CLOSERS) {
		if (typeof resource?.[method] !== "function") continue;
		if (method === "stop") resource.stop(true);
		else resource[method]();
		return;
	}
}

function ownResultsOf(owner, names, patched) {
	for (const name of names) {
		const original = owner?.[name];
		if (typeof original !== "function") continue;
		const own = function (...args) {
			const cell = currentCell();
			if (cell === undefined) return original.apply(this, args);
			if (cell.released) throw cell.interruption;
			const result = original.apply(this, args);
			const register = (resource) => {
				onReleaseOf(cell, () => closeResource(resource));
				return resource;
			};
			return result instanceof Promise ? result.then(register) : register(result);
		};
		Object.assign(own, original);
		replace(owner, name, own, patched);
	}
}

// `globals` is the global scope already patched: a module binding that is the same owned function is left alone.
function patchTimers(scope, patched, globals = undefined) {
	for (const [name, clearName] of [
		["setTimeout", "clearTimeout"],
		["setInterval", "clearInterval"],
		["setImmediate", "clearImmediate"],
	]) {
		const original = scope?.[name];
		const clear = scope?.[clearName];
		if (typeof original !== "function" || typeof clear !== "function") continue;
		if (globals !== undefined && original === globals[name]) continue;
		const owned = function (callback, ...rest) {
			const cell = currentCell();
			if (cell === undefined || typeof callback !== "function") return original.call(this, callback, ...rest);
			if (cell.released) {
				const never = original.call(this, () => {}, ...rest);
				clear.call(scope, never);
				return never;
			}
			let forget = () => {};
			const handle = original.call(
				this,
				function (...args) {
					if (name !== "setInterval") forget();
					return callback.apply(this, args);
				},
				...rest,
			);
			forget = onReleaseOf(cell, () => clear.call(scope, handle));
			return handle;
		};
		Object.assign(owned, original);
		replace(scope, name, owned, patched);
	}
}

function patchPromiseApi(owner, name, patched) {
	const original = owner?.[name];
	if (typeof original !== "function") return;
	const bound = function (...args) {
		const cell = currentCell();
		if (cell === undefined) return original.apply(this, args);
		if (cell.released) return Promise.reject(cell.interruption);
		return settleWithCell(cell, original.apply(this, args));
	};
	Object.assign(bound, original);
	replace(owner, name, bound, patched);
}

function patchTimerPromises(patched) {
	const timers = builtin("node:timers/promises");
	if (timers === undefined) return;
	patchPromiseApi(timers, "setTimeout", patched);
	patchPromiseApi(timers, "setImmediate", patched);
	const original = timers.setInterval;
	if (typeof original !== "function") return;
	const owned = function (...args) {
		const cell = currentCell();
		if (cell?.released) throw cell.interruption;
		const iterator = original.apply(this, args);
		if (cell === undefined) return iterator;
		onReleaseOf(cell, () => void iterator.return?.());
		return iterator;
	};
	replace(timers, "setInterval", owned, patched);
}

function patchFetch(scope, patched, name = "fetch") {
	const original = scope[name];
	if (typeof original !== "function") return;
	const owned = function (input, init) {
		const cell = currentCell();
		if (cell === undefined) return original.call(this, input, init);
		if (cell.released) return Promise.reject(cell.interruption);
		const controller = new AbortController();
		const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const signal = own === undefined ? controller.signal : AbortSignal.any([own, controller.signal]);
		const forget = onReleaseOf(cell, () => controller.abort(cell.interruption));
		return original.call(this, input, { ...init, signal }).finally(forget);
	};
	Object.assign(owned, original);
	replace(scope, name, owned, patched);
}

// A released cell's code may still be resumed by a short I/O completion; refusing new I/O at that point makes such a
// loop throw the interruption on its next operation instead of running on in the kept worker.
function refuseWhenReleased(owner, names, patched) {
	for (const name of names) {
		const original = owner?.[name];
		if (typeof original !== "function") continue;
		const guarded = function (...args) {
			const cell = currentCell();
			if (cell?.released) throw cell.interruption;
			const result = original.apply(this, args);
			return cell === undefined ? result : settleWithCell(cell, result);
		};
		Object.assign(guarded, original);
		replace(owner, name, guarded, patched);
	}
}

// The callback form: a released cell's operation is never started, so its callback never runs, the same way a timer a
// released cell sets never fires.
function neverStartWhenReleased(owner, names, patched) {
	for (const name of names) {
		const original = owner?.[name];
		if (typeof original !== "function") continue;
		const guarded = function (...args) {
			if (currentCell()?.released) return undefined;
			return original.apply(this, args);
		};
		Object.assign(guarded, original);
		replace(owner, name, guarded, patched);
	}
}

const FS_OPERATIONS = ["readFile", "writeFile", "appendFile", "readdir", "stat", "lstat", "open", "access", "mkdir", "rm", "unlink", "rename", "copyFile"];

// For ES classes only (Worker, WebSocket, MessageChannel): `instanceof` keeps accepting instances the runtime creates
// internally from the original class. Node's function-style constructors are owned on activation instead.
function patchClass(scope, name, close, patched) {
	const Original = scope?.[name];
	if (typeof Original !== "function") return;
	const Owned = class extends Original {
		constructor(...args) {
			const cell = currentCell();
			if (cell?.released) throw cell.interruption;
			super(...args);
			if (cell !== undefined) onReleaseOf(cell, () => close(this));
		}
		static [Symbol.hasInstance](value) {
			return value instanceof Original;
		}
	};
	Object.defineProperty(Owned, "name", { value: Original.name });
	replace(scope, name, Owned, patched);
}

const NODE_RESOURCE_FACTORIES = {
	"node:net": ["createConnection", "connect", "createServer"],
	"node:tls": ["connect", "createServer"],
	"node:http": ["request", "get", "createServer"],
	"node:https": ["request", "get", "createServer"],
	"node:dgram": ["createSocket"],
	"node:fs": ["createReadStream", "createWriteStream", "watch"],
	"node:readline": ["createInterface"],
	"node:readline/promises": ["createInterface"],
};

// Node's socket and server types are function-style constructors that Node's own subclasses call with `.call(this)`
// (http.Server calls net.Server), so they cannot be swapped for a class. A socket or server only does anything once it
// connects, listens or binds, so that call is where a cell takes ownership of it; http, https and tls inherit these.
const NODE_ACTIVATIONS = {
	"node:net": { Socket: ["connect"], Server: ["listen"] },
	"node:dgram": { Socket: ["bind"] },
};

function ownOnActivation(proto, names, patched) {
	for (const name of names) {
		const original = proto?.[name];
		if (typeof original !== "function") continue;
		const owned = new WeakSet();
		const activate = function (...args) {
			const cell = currentCell();
			if (cell === undefined) return original.apply(this, args);
			if (cell.released) throw cell.interruption;
			if (!owned.has(this)) {
				owned.add(this);
				onReleaseOf(cell, () => closeResource(this));
			}
			return original.apply(this, args);
		};
		replace(proto, name, activate, patched);
	}
}

export function installCellOwnership(scope = globalThis) {
	const patched = [];
	patchTimers(scope, patched);
	patchTimers(builtin("node:timers"), patched, scope);
	patchTimerPromises(patched);
	patchFetch(scope, patched);
	patchClass(scope, "WebSocket", (socket) => socket.close(), patched);
	patchClass(scope, "Worker", (worker) => void worker.terminate(), patched);
	refuseWhenReleased(builtin("node:fs/promises"), FS_OPERATIONS, patched);
	neverStartWhenReleased(builtin("node:fs"), FS_OPERATIONS, patched);
	patchClass(scope, "MessageChannel", (channel) => {
		channel.port1.close();
		channel.port2.close();
	}, patched);
	patchClass(scope, "BroadcastChannel", (channel) => channel.close(), patched);
	const bun = scope.Bun;
	if (bun !== undefined) {
		patchPromiseApi(bun, "sleep", patched);
		if (bun.fetch !== scope.fetch) patchFetch(bun, patched, "fetch");
		refuseWhenReleased(bun, ["file", "write"], patched);
		ownResultsOf(bun, ["connect", "listen", "serve", "udpSocket"], patched);
	}
	for (const [module, factories] of Object.entries(NODE_RESOURCE_FACTORIES)) ownResultsOf(builtin(module), factories, patched);
	patchClass(builtin("node:worker_threads"), "Worker", (worker) => void worker.terminate(), patched);
	for (const [module, types] of Object.entries(NODE_ACTIVATIONS)) {
		for (const [name, methods] of Object.entries(types)) ownOnActivation(builtin(module)?.[name]?.prototype, methods, patched);
	}
	// Node hands `import("node:…")` its own ESM namespace; without this sync a cell importing the module gets the
	// unowned originals.
	syncBuiltinExports();
	return () => {
		for (const undo of patched.reverse()) undo();
		syncBuiltinExports();
	};
}

function syncBuiltinExports() {
	builtin("node:module")?.syncBuiltinESMExports?.();
}
