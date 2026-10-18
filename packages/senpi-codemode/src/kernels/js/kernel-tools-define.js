export function createToolNamespace(define, callHost, registry = {}) {
	const registrar = function tool(fn, metadata) {
		return define(fn, metadata);
	};
	return new Proxy(registrar, {
		get(target, prop) {
			if (typeof prop !== "string") return undefined;
			if (prop in Function.prototype || prop === "arguments" || prop === "caller") return target[prop];
			if (prop === "defined" && registry.defined) return () => registry.defined();
			if (prop === "undefine" && registry.undefine) return (name) => registry.undefine(name);
			return async (args) => await callHost(prop, args ?? {});
		},
	});
}
