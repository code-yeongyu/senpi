import type { ExtensionRpcRequestContext } from "./rpc-context.ts";
import type { Extension } from "./types.ts";

export class ExtensionRpcRequestNotFoundError extends Error {
	constructor(name: string) {
		super(`Unknown extension RPC request: ${name}`);
		this.name = "ExtensionRpcRequestNotFoundError";
	}
}

export async function requestExtensionRpc(
	extensions: readonly Extension[],
	name: string,
	data: unknown,
	context: ExtensionRpcRequestContext | undefined,
	assertActive: () => void,
): Promise<unknown> {
	assertActive();
	const normalizedName = name.trim();
	if (normalizedName.length === 0) throw new Error("Extension RPC request name must not be empty");
	const matches = extensions.flatMap((extension) => {
		const handler = extension.rpcHandlers?.get(normalizedName);
		return handler === undefined ? [] : [handler];
	});
	if (matches.length === 0) throw new ExtensionRpcRequestNotFoundError(normalizedName);
	if (matches.length > 1) throw new Error(`Multiple extension RPC request handlers registered: ${normalizedName}`);
	const invoke = () => matches[0]?.(data, context);
	const result = await (context === undefined ? invoke() : context.admit(invoke));
	assertActive();
	return context === undefined ? result : context.admit(() => result);
}
