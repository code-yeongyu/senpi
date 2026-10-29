import { replaceMethod } from "./interpose-paths.js";

export function installCapabilityPermissions(check) {
	const refuse = () => check(() => ({ unsupported: true }));
	for (const name of ["binding", "_linkedBinding", "dlopen"]) {
		replaceMethod(process, name, (original) => function (...args) {
			refuse();
			return original.apply(this, args);
		});
	}
	if (globalThis.Bun) {
		const original = globalThis.Bun.plugin;
		Object.defineProperty(globalThis, Symbol.for("senpi.kernel.permissionBunPlugin"), { value: function (...args) {
			refuse();
			return original(...args);
		} });
	}
	const module = process.getBuiltinModule("node:module");
	replaceMethod(module, "register", (original) => function (...args) {
		refuse();
		return original.apply(this, args);
	});
	let load = module._load;
	Object.defineProperty(module, "_load", {
		configurable: true, enumerable: true,
		get: () => load,
		set(value) { refuse(); load = value; },
	});
}
