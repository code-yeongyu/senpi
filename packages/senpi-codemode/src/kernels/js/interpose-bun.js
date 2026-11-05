import { checkPath, executionPath, replaceMethod } from "./interpose-paths.js";

const READERS = ["text", "json", "bytes", "arrayBuffer", "stream", "formData", "image"];
const ignore = () => {};
const WRITERS = ["write", "delete", "unlink"];

export function installBunPermissions(check, resources) {
	const bun = globalThis.Bun;
	const stand = new WeakMap();
	const unwrap = (value) => stand.get(value) ?? value;
	const files = { source: () => {}, destination: () => {}, handle: () => false };
	if (typeof bun?.file === "function") {
		const originalFile = bun.file;
		const proto = Object.getPrototypeOf(originalFile(new URL(import.meta.url)));
		// Captured before any cell runs, so a per-instance "name" cannot redirect a decision away
		// from the path the runtime will actually open.
		const nativePath = Object.getOwnPropertyDescriptor(proto, "name").get;
		const nativeStat = proto.stat;
		// A memory Blob carries no file and answers nothing; anything the native stat does answer for is
		// backed by a file this decision cannot name, which is what makes it undecidable rather than safe.
		const fileBacked = (value) => {
			let pending;
			try {
				pending = nativeStat.call(value);
			} catch {
				return true;
			}
			if (pending === undefined) return false;
			if (typeof pending?.then === "function") pending.then(ignore, ignore);
			return true;
		};
		const pathOf = (value) => {
			try {
				return nativePath.call(unwrap(value));
			} catch {
				return undefined;
			}
		};
		const granted = (value, mode) => {
			const grant = resources.path(value);
			if (grant === undefined) return false;
			resources.use(typeof grant === "number" ? grant : value, mode);
			return true;
		};
		const handle = (value, mode) => {
			if (typeof value === "number") return granted(value, mode);
			if (value === null || typeof value !== "object") return false;
			const path = pathOf(value);
			if (typeof path === "string") {
				checkPath(check, mode, path);
				return true;
			}
			if (granted(unwrap(value), mode)) return true;
			if (!(unwrap(value) instanceof Blob)) return false;
			// A file-backed handle whose path cannot be read cannot be decided, so it never receives bytes
			// and never hands any out either.
			if (mode === "write") check(() => ({ unsupported: true }));
			if (mode === "read") check(() => (fileBacked(unwrap(value)) ? { unsupported: true } : { granted: true })); // sink:undecidable-read
			return true;
		};
		const source = (value) => {
			for (const part of Array.isArray(value) ? value : [value]) handle(part, "read");
		};
		const destination = (value) => {
			if (typeof value === "number") resources.use(value, "write");
			else if (!handle(value, "write")) checkPath(check, "write", value);
		};
		const native = (value) => (Array.isArray(value) ? value.map(unwrap) : unwrap(value));
		Object.assign(files, { source, destination, handle });
		const standIn = (file) => {
			// Metadata answers for the same file the content was refused for, so it is decided the same way.
			const metadata = () => checkPath(check, "read", nativePath.call(file));
			const surface = {
				exists: (...args) => {
					metadata(); // sink:standin-metadata
					return proto.exists.apply(file, args);
				},
				stat: (...args) => {
					metadata(); // sink:standin-metadata
					return nativeStat.apply(file, args);
				},
				slice: (...args) => standIn(proto.slice.apply(file, args)),
			};
			// The native accessors live on the prototype, so these stay off the own enumerable surface too:
			// a structured-clone walk still fails on the missing internal slots rather than on a check.
			Object.defineProperties(surface, {
				name: { get: () => nativePath.call(file), configurable: true },
				type: { get: () => file.type, configurable: true },
				size: {
					get: () => {
						metadata(); // sink:standin-metadata
						return file.size;
					},
					configurable: true,
				},
				lastModified: {
					get: () => {
						metadata(); // sink:standin-metadata
						return file.lastModified;
					},
					configurable: true,
				},
			});
			for (const name of [...READERS, ...WRITERS, "writer"]) {
				surface[name] = (...args) => proto[name].apply(file, args);
			}
			stand.set(surface, file);
			return surface;
		};
		for (const name of READERS) {
			replaceMethod(proto, name, (original) => function (...args) {
				source(this); // sink:bunfile-read
				return original.apply(unwrap(this), args);
			});
		}
		for (const name of WRITERS) {
			replaceMethod(proto, name, (original) => function (...args) {
				destination(this); // sink:bunfile-write
				if (name === "write") source(args[0]); // sink:bunfile-write-parts
				return original.apply(unwrap(this), name === "write" ? [native(args[0]), ...args.slice(1)] : args);
			});
		}
		replaceMethod(proto, "writer", (original) => function (...args) {
			destination(this); // sink:bunfile-writer
			const writer = original.apply(unwrap(this), args);
			resources.record(writer, pathOf(this), ["write"]);
			for (const name of ["write", "flush", "end"]) {
				replaceMethod(writer, name, (fn) => function (...parameters) {
					resources.use(this, "write");
					return fn.apply(this, parameters);
				});
			}
			return writer;
		});
		bun.file = function (path, ...args) {
			const file = originalFile.call(this, executionPath(path), ...args);
			if (typeof path === "number") return resources.record(file, path, ["read", "write"]);
			try {
				checkPath(check, "read", path); // sink:bun-file-mint
			} catch (error) {
				if (error?.code !== "cell_permission_denied") throw error;
				// A denied path yields a stand-in with no internal slots, so every native consumer
				// of a file handle refuses it instead of reading the file behind our back.
				return standIn(file);
			}
			return file;
		};
		replaceMethod(bun, "write", (original) => function (target, data, ...args) {
			destination(target); // sink:bun-write-destination
			source(data); // sink:bun-write-parts
			return original.call(this, executionPath(unwrap(target)), native(data), ...args);
		});
		// A route value may be a per-method map ({'/f':{GET: handle}}), which Bun reads the handle out of
		// exactly like the flat form, so every nested value is decided too.
		const nestedRoutes = (value, depth, seen) => {
			if (value === null || typeof value !== "object" || depth === 0 || seen.has(value)) return;
			if (unwrap(value) instanceof Blob) return;
			seen.add(value);
			for (const inner of Object.values(value)) {
				source(inner);
				nestedRoutes(inner, depth - 1, seen);
			}
		};
		replaceMethod(bun, "serve", (original) => function (options, ...args) {
			for (const map of [options?.routes, options?.static]) {
				for (const value of map === null || typeof map !== "object" ? [] : Object.values(map)) {
					source(value); // sink:bun-serve
					nestedRoutes(value, 3, new Set()); // sink:bun-serve-nested
				}
			}
			return original.call(this, options, ...args);
		});
		const buffer = process.getBuiltinModule("node:buffer");
		for (const name of ["Blob", "File", "Response", "Request"]) {
			const original = globalThis[name];
			const guarded = new Proxy(original, {
				construct(target, args, newTarget) {
					if (name === "Blob" || name === "File") source(args[0]);
					else source(name === "Response" ? args[0] : args[1]?.body);
					return Reflect.construct(target, args, newTarget);
				},
			});
			globalThis[name] = guarded;
			if (buffer[name] === original) buffer[name] = guarded;
			if (original.prototype.constructor === original) {
				Object.defineProperty(original.prototype, "constructor", { value: guarded });
			}
		}
		for (const name of ["append", "set"]) {
			replaceMethod(FormData.prototype, name, (original) => function (key, value, ...args) {
				source(value);
				return original.call(this, key, value, ...args);
			});
		}
	}
	if (bun?.Glob) {
		for (const name of ["scan", "scanSync"]) {
			replaceMethod(bun.Glob.prototype, name, (original) => function (options) {
				const cwd = typeof options === "string" ? options : (options?.cwd ?? process.cwd());
				checkPath(check, "ls", cwd);
				return original.call(
					this,
					typeof options === "string" ? executionPath(cwd) : { ...options, cwd: executionPath(cwd) },
				);
			});
		}
	}
	replaceMethod(bun, "mmap", (original) => function (path, options) {
		check(() => ({ granted: true, unsupported: options?.shared !== false }));
		checkPath(check, "read", path);
		return original.call(this, executionPath(path), options);
	});
	replaceMethod(globalThis, "fetch", (original) => function (input, ...args) {
		const href = input instanceof Request ? input.url : String(input);
		if (href.startsWith("file:")) checkPath(check, "read", new URL(href));
		files.source(args[0]?.body);
		return original.call(this, input, ...args);
	});
	return files;
}
