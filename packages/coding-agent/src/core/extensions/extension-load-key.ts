import type { ExtensionAPI } from "./types.ts";

const loadKeys = new WeakMap<object, object>();

export function recordExtensionLoadKey(api: ExtensionAPI, load: object): void {
	loadKeys.set(api, load);
}

/** The opaque identity of the extension load that created `api`; the host keys the same load by its runtime. */
export function extensionLoadKey(api: object): object | undefined {
	return loadKeys.get(api);
}
