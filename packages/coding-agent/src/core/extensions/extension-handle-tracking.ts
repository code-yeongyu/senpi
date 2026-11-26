import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Process-level hooks that record the servers, sockets and timers an extension's own
 * code creates, so a session can close what its extension instances left open
 * (senpi#2292).
 *
 * Two facts decide ownership. The async context (`handleOwnerStore`) says which
 * session's extension instance the work runs for: senpi enters it around every call
 * into extension code. The creating stack frame says whether the extension's code
 * created the handle or senpi code running on its behalf did (a turn the extension
 * started, a UI toast it showed): only the first is recorded. Senpi's own timers
 * therefore never end with an extension's session.
 */
export type OwnedHandleKind = "server" | "socket" | "timer";

export interface HandleOwner {
	/** True when a handle created by code at `path` belongs to this owner. */
	ownsCreatorFrame(path: string): boolean;
	/** Records a handle; the returned function forgets it once the extension released it itself. */
	track(kind: OwnedHandleKind, release: () => void): () => void;
}

export const handleOwnerStore = new AsyncLocalStorage<HandleOwner>();

/**
 * `at fn (/abs/file.ts:1:2)`, `at /abs/file.ts:1:2`, or Node's ESM form `at fn (file:///abs/file.mjs:1:2)`;
 * `node:` and `native` frames never match.
 */
const FRAME_PATH = /(?:^|[\s(])((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^()]*?):\d+:\d+\)?$/;
/**
 * A file extension Bun loads through senpi's importer names its frames by module id,
 * `senpi-extension:<generation>/<encodeURIComponent(filename)>` (`bun-extension-registry.ts`).
 * Not imported from there: the registry is Bun-only and loads lazily.
 */
const EXTENSION_MODULE_FRAME = /(?:^|[\s(])senpi-extension:[^/\s()]+\/([^\s()]+?):\d+:\d+\)?$/;
const CREATOR_STACK_DEPTH = 16;
/**
 * `creatorPath`, `creatingOwner` and the patched function sit above the creating call. Skipped by count, not
 * by file: in a bundled build every senpi module shares one file, and skipping by file would skip senpi code
 * that created the handle and blame the extension frame below it.
 */
const TRACKING_FRAMES = 3;

function creatorPath(): string | undefined {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = CREATOR_STACK_DEPTH;
	const stack = new Error().stack ?? "";
	Error.stackTraceLimit = limit;
	for (const line of stack.split("\n").slice(1 + TRACKING_FRAMES)) {
		const frame = line.trim();
		const moduleFile = EXTENSION_MODULE_FRAME.exec(frame)?.[1];
		if (moduleFile !== undefined) return decodeURIComponent(moduleFile);
		const location = FRAME_PATH.exec(frame)?.[1];
		if (location === undefined) continue;
		return location.startsWith("file://") ? fileURLToPath(location) : location;
	}
	return undefined;
}

function creatingOwner(): HandleOwner | undefined {
	const owner = handleOwnerStore.getStore();
	if (owner === undefined) return undefined;
	const path = creatorPath();
	return path !== undefined && owner.ownsCreatorFrame(path) ? owner : undefined;
}

/** Keeps `util.promisify(setTimeout)` and friends working on the patched globals. */
function replaceGlobal(target: object, name: string, patched: object): void {
	const native: unknown = Reflect.get(target, name);
	if (typeof native === "function") {
		for (const key of Reflect.ownKeys(native)) {
			if (key === "length" || key === "name" || key === "prototype") continue;
			const descriptor = Reflect.getOwnPropertyDescriptor(native, key);
			if (descriptor) Reflect.defineProperty(patched, key, descriptor);
		}
	}
	Reflect.set(target, name, patched);
}

const forgetByTimer = new WeakMap<object, () => void>();

function patchTimer(name: "setTimeout" | "setInterval", clearName: "clearTimeout" | "clearInterval"): void {
	const native: unknown = Reflect.get(globalThis, name);
	const clear: unknown = Reflect.get(globalThis, clearName);
	if (typeof native !== "function" || typeof clear !== "function") return;
	const oneShot = name === "setTimeout";
	const patched = function (this: unknown, callback: unknown, ...rest: unknown[]): unknown {
		const owner = typeof callback === "function" ? creatingOwner() : undefined;
		if (owner === undefined || typeof callback !== "function")
			return Reflect.apply(native, this, [callback, ...rest]);
		let forget = (): void => {};
		const run = oneShot
			? function (this: unknown, ...args: unknown[]): unknown {
					forget();
					return Reflect.apply(callback, this, args);
				}
			: callback;
		const handle: unknown = Reflect.apply(native, this, [run, ...rest]);
		forget = owner.track("timer", () => Reflect.apply(clear, globalThis, [handle]));
		if (typeof handle === "object" && handle !== null) forgetByTimer.set(handle, forget);
		return handle;
	};
	replaceGlobal(globalThis, name, patched);
}

function patchClear(name: "clearTimeout" | "clearInterval"): void {
	const native: unknown = Reflect.get(globalThis, name);
	if (typeof native !== "function") return;
	const patched = function (this: unknown, handle: unknown): unknown {
		if (typeof handle === "object" && handle !== null) {
			forgetByTimer.get(handle)?.();
			forgetByTimer.delete(handle);
		}
		return Reflect.apply(native, this, [handle]);
	};
	replaceGlobal(globalThis, name, patched);
}

interface Stoppable {
	stop(closeActiveConnections?: boolean): unknown;
}

function isStoppable(value: unknown): value is Stoppable {
	return typeof value === "object" && value !== null && "stop" in value && typeof value.stop === "function";
}

/** `Bun.serve` (which also backs Bun's `node:http` servers) and `Bun.listen`. */
function patchBunFactory(name: "serve" | "listen"): void {
	const bun: unknown = Reflect.get(globalThis, "Bun");
	if (typeof bun !== "object" || bun === null) return;
	const native: unknown = Reflect.get(bun, name);
	if (typeof native !== "function") return;
	const patched = function (this: unknown, ...args: unknown[]): unknown {
		const value: unknown = Reflect.apply(native, this, args);
		const owner = isStoppable(value) ? creatingOwner() : undefined;
		if (owner === undefined || !isStoppable(value)) return value;
		const stop = value.stop;
		const forget = owner.track("server", () => Reflect.apply(stop, value, [true]));
		value.stop = function (this: unknown, ...stopArgs: unknown[]): unknown {
			forget();
			return Reflect.apply(stop, this, stopArgs);
		};
		return value;
	};
	replaceGlobal(bun, name, patched);
}

/** `node:net` servers (Node's `node:http` included) and client sockets. */
function patchNet(): void {
	const listen = net.Server.prototype.listen;
	Reflect.set(net.Server.prototype, "listen", function (this: net.Server, ...args: unknown[]): unknown {
		const owner = creatingOwner();
		if (owner !== undefined)
			this.once(
				"close",
				owner.track("server", () => this.close()),
			);
		return Reflect.apply(listen, this, args);
	});
	const connect = net.Socket.prototype.connect;
	Reflect.set(net.Socket.prototype, "connect", function (this: net.Socket, ...args: unknown[]): unknown {
		const owner = creatingOwner();
		if (owner !== undefined)
			this.once(
				"close",
				owner.track("socket", () => this.destroy()),
			);
		return Reflect.apply(connect, this, args);
	});
}

let installed = false;

/** Installs the hooks once per process; a no-op for every call after the first. */
export function installHandleTracking(): void {
	if (installed) return;
	installed = true;
	patchTimer("setTimeout", "clearTimeout");
	patchTimer("setInterval", "clearInterval");
	patchClear("clearTimeout");
	patchClear("clearInterval");
	patchBunFactory("serve");
	patchBunFactory("listen");
	patchNet();
}
