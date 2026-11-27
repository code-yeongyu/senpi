import { checkPath, requestedPath } from "./interpose-paths.js";

const { dirname, isAbsolute, resolve } = process.getBuiltinModule("node:path");
const { fileURLToPath } = process.getBuiltinModule("node:url");

export function installModulePermissions(check, userWorker = false) {
	const module = process.getBuiltinModule("node:module");
	const nativeRequire = module.createRequire(import.meta.url);
	const resolveSync = globalThis.Bun?.resolveSync;
	let sealed = false;
	// Resolving a specifier re-enters this hook, because the engine resolver is itself observed. That
	// re-entry is one import still being decided, not another import, so it must not ask again.
	let resolving = false;
	// A user worker's own script reaches its own workerData and parentPort through this module, which
	// #4387 keeps transparent, so only the cell context treats the module itself as a capability.
	const forbidden = userWorker
		? /^(?:bun:ffi|(?:node:)?vm)$/u
		: /^(?:bun:ffi|(?:node:)?(?:vm|worker_threads))$/u;
	const workerThreads = /^(?:node:)?worker_threads$/u;
	// A cell already owns these as globals, so handing them back over require grants nothing, while
	// Worker, parentPort and workerData stay out of reach: the raw Worker would spawn an uninterposed
	// one. Only require can substitute a namespace, so import and getBuiltinModule stay refused.
	const portPrimitives = () =>
		Object.freeze(
			Object.fromEntries(
				["MessageChannel", "MessagePort", "BroadcastChannel"]
					.filter((name) => name in globalThis)
					.map((name) => [name, globalThis[name]]),
			),
		);
	const pathLike = (name) => name.startsWith(".") || isAbsolute(name) || name.startsWith("file:");
	const guard = (source, importer) => {
		const specifier = String(source);
		if (!sealed || resolving) return;
		if (forbidden.test(specifier) || specifier.endsWith(".node")) check(() => ({ unsupported: true }));
		if (!pathLike(specifier)) return;
		const parent = importer?.startsWith("file:") ? fileURLToPath(importer) : importer;
		const base = parent ? dirname(parent) : process.cwd();
		const candidate = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
		let target;
		resolving = true;
		try {
			target = resolveSync ? resolveSync(candidate, base) : nativeRequire.resolve(resolve(base, candidate));
		} catch {
			target = isAbsolute(candidate) ? candidate : resolve(base, candidate);
		} finally {
			resolving = false;
		}
		checkPath(check, "read", target);
	};
	// Only resolution is observed: Bun owns every loader and import attribute.
	if (globalThis.Bun?.plugin) {
		Bun.plugin({
			name: "senpi-cell-permissions",
			setup(build) {
				build.onResolve({ filter: /.*/u }, (args) => { guard(args.path, args.importer); });
			},
		});
	}
	// The decision comes first. A cell nothing is enforced against sees the engine's own module, so
	// no-rules behaviour is unchanged and matches what import() returns; only a refusal is answered
	// with the port primitives the cell already owns as globals.
	const requireGuard = (specifier, importer) => {
		if (!sealed || !workerThreads.test(String(specifier))) {
			guard(specifier, importer);
			return undefined;
		}
		try {
			guard(specifier, importer);
		} catch (error) {
			if (error?.code !== "cell_permission_denied") throw error;
			return portPrimitives();
		}
		return undefined;
	};
	const originalRequire = module.prototype.require;
	module.prototype.require = function (specifier) {
		const substitute = requireGuard(specifier, this.filename);
		if (substitute) return substitute;
		if (specifier === "bun" && globalThis.Bun) return globalThis[Symbol.for("senpi.kernel.bun")] ?? globalThis.Bun;
		return originalRequire.call(this, specifier);
	};
	const originalCreateRequire = module.createRequire;
	module.createRequire = function (...args) {
		const require = originalCreateRequire.apply(this, args);
		const guarded = function (specifier) {
			const substitute = requireGuard(specifier, requestedPath(args[0]) ?? String(args[0]));
			if (substitute) return substitute;
			if (specifier === "bun" && globalThis.Bun) return globalThis[Symbol.for("senpi.kernel.bun")] ?? globalThis.Bun;
			return require(specifier);
		};
		Object.assign(guarded, require);
		guarded.cache = new Proxy(require.cache, {
			set(target, name, value) { check(() => ({ unsupported: true })); return Reflect.set(target, name, value); },
			deleteProperty(target, name) { check(() => ({ unsupported: true })); return Reflect.deleteProperty(target, name); },
			defineProperty(target, name, descriptor) { check(() => ({ unsupported: true })); return Reflect.defineProperty(target, name, descriptor); },
		});
		return guarded;
	};
	const getBuiltin = process.getBuiltinModule;
	process.getBuiltinModule = function (name) {
		if (sealed && forbidden.test(name)) check(() => ({ unsupported: true }));
		return getBuiltin.call(this, name);
	};
	Object.defineProperty(globalThis, Symbol.for("senpi.kernel.permissionImport"), { value: guard });
	return () => { sealed = true; };
}
