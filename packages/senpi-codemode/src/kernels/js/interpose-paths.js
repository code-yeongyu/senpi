import { createPathIdentity, PATH_IDENTITY_VERSION } from "../shared/path-identity.mjs";

const path = process.getBuiltinModule("node:path");
const fs = process.getBuiltinModule("node:fs");
const { fileURLToPath } = process.getBuiltinModule("node:url");

// Captured at module evaluation, before any interposition or cwd patch replaces them: the identity
// must resolve with the engine's own native realpath and must never reach the live `path.resolve`
// that worker-cwd.js rebinds to the session root (design N11).
const identity = createPathIdentity({
	realpathNative: fs.realpathSync.native,
	lstat: fs.lstatSync,
	readlink: fs.readlinkSync,
	pathApi: {
		join: path.join,
		dirname: path.dirname,
		basename: path.basename,
		isAbsolute: path.isAbsolute,
		sep: path.sep,
		win32Resolve: path.win32.resolve,
	},
	platform: process.platform,
});

export function requestedPath(value) {
	if (value instanceof URL) return fileURLToPath(value);
	if (value instanceof Uint8Array) {
		const text = Buffer.from(value).toString();
		return Buffer.from(text).equals(value) ? text : undefined;
	}
	return typeof value === "string" ? value : undefined;
}

export function executionPath(value) {
	if (typeof value === "string") return path.resolve(process.cwd(), value);
	if (value instanceof Uint8Array && !path.isAbsolute(Buffer.from(value).toString("latin1"))) {
		return Buffer.concat([Buffer.from(process.cwd() + path.sep), value]);
	}
	return value;
}

/** The written spelling, the executed spelling, and the kernel-computed canonical form (or why there is none). */
function pathIdentityInput(value, executed = requestedPath(executionPath(value))) {
	const requested = requestedPath(value);
	if (requested === undefined || executed === undefined) return { input: { path: requested }, unsupported: true };
	const input = { path: requested, executedPath: executed };
	try {
		const { path: canonical, foldCase } = identity.canonical(executed);
		input.canonical = { v: PATH_IDENTITY_VERSION, path: canonical, foldCase };
	} catch (error) {
		input.unresolvable = typeof error?.code === "string" ? error.code : "EUNKNOWN";
	}
	return { input, unsupported: false };
}

export function checkPath(check, tool, value, options = {}) {
	try {
		check(() => {
			const { input, unsupported } = pathIdentityInput(value, options.executed);
			return { call: { tool, input, cwd: options.cwd ?? process.cwd() }, unsupported };
		});
	} catch (error) {
		if (error?.code === "cell_permission_denied" && typeof value === "string") error.message += `: ${value}`;
		throw error;
	}
}

export function replaceMethod(owner, name, wrap) {
	const original = owner?.[name];
	if (typeof original !== "function") return;
	const wrapped = wrap(original);
	for (const key of Reflect.ownKeys(original)) {
		if (key === "length" || key === "name" || key === "prototype" || Object.hasOwn(wrapped, key)) continue;
		Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
	}
	Object.defineProperty(owner, name, {
		...(Object.getOwnPropertyDescriptor(owner, name) ?? { configurable: true, writable: true, enumerable: false }),
		value: wrapped,
	});
}
