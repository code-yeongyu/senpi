export type NativeAgentPermissionRequest = {
	readonly provider: string;
	readonly kind?: string;
	readonly title: string;
	readonly rawInput?: unknown;
};

type NativeAgentPermissionHandler = (request: NativeAgentPermissionRequest) => Promise<boolean>;

const handlers = new Map<string, NativeAgentPermissionHandler>();

export function registerNativeAgentPermissionHandler(
	sessionId: string,
	handler: NativeAgentPermissionHandler,
): () => void {
	handlers.set(sessionId, handler);
	return () => {
		if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
	};
}

export async function requestNativeAgentPermission(
	sessionId: string | undefined,
	request: NativeAgentPermissionRequest,
): Promise<boolean> {
	if (sessionId === undefined) return false;
	const handler = handlers.get(sessionId);
	return handler ? handler(request) : false;
}
