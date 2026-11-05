/** A host-issued transport incarnation. Never constructed from extension request JSON. */
export interface ExtensionRpcRequestContext {
	readonly ownerId: string;
	/** Lasts beyond one request and aborts when the captured owner/binding retires. */
	readonly disconnectSignal: AbortSignal;
	/**
	 * Admit and immediately dispatch one effect. The callback may return its in-flight
	 * promise, but must not await preparation before starting the effect.
	 */
	readonly admit: <T>(dispatch: () => T) => T;
}

/** Internal calls without a transport explicitly pass undefined. */
export type ExtensionRpcRequestHandler = (
	data: unknown,
	context?: ExtensionRpcRequestContext,
) => unknown | Promise<unknown>;
