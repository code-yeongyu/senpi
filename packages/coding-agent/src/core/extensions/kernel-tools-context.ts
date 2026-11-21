import { AsyncLocalStorage } from "node:async_hooks";
import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";

/** Host tools a kernel-tool invocation's nested calls may reach. `deny` wins when both name the same tool. */
export type KernelToolInvokeScope = {
	tools?: {
		allow?: string[];
		deny?: string[];
	};
};

export type KernelToolInvokeOptions = {
	signal?: AbortSignal;
	scope?: KernelToolInvokeScope;
	/** Host dispatcher identity, never read from a tool's arguments or cell data. */
	invoker?: { readonly sessionId: string };
};

export type ExtensionKernelTools = {
	readonly capabilities: {
		readonly invokeScope: boolean;
	};
	describe(names: readonly string[]): Promise<unknown>;
	invoke(
		request: {
			name: string;
			kernel_generation: number;
			definition_revision: number;
			args: unknown;
			call_id: string;
		},
		options?: AbortSignal | KernelToolInvokeOptions,
	): Promise<unknown>;
};

type KernelToolInvoker = { readonly sessionId: string };

/**
 * The two kernel-tool async contexts of every engine copy in this realm (omo#12965). The codemode extension, the tool
 * dispatcher, the extension loader and the tool wrapper enter them, and the extension runner reads them; those can be
 * different copies of the engine in one process (the bundled engine next to the SDK graph an extension imports), so the
 * two stores are one realm registry. `storage` is the public `kernelToolsStorage` export. `invokerStorage` is exported
 * by this module as `kernelToolInvokerStorage` but not from the package entry, and the registry makes it reachable to
 * code in the realm; that adds no reach, because the raw `invoke` of the public store already takes the invoker from
 * its caller (`options.invoker`).
 * A reader validates what it finds: a store value another copy shaped differently reads as absent.
 */
interface KernelToolContexts {
	readonly storage: AsyncLocalStorage<ExtensionKernelTools>;
	readonly invokerStorage: AsyncLocalStorage<KernelToolInvoker>;
}

const isAsyncContext = (value: unknown): boolean => hasFunctions(value, ["run", "exit", "getStore"]);

const kernelToolContexts = realmRegistry(
	"@code-yeongyu/senpi/kernel-tools/v1",
	(): KernelToolContexts => ({
		storage: new AsyncLocalStorage<ExtensionKernelTools>(),
		invokerStorage: new AsyncLocalStorage<KernelToolInvoker>(),
	}),
	(value): value is KernelToolContexts =>
		typeof value === "object" &&
		value !== null &&
		isAsyncContext(Reflect.get(value, "storage")) &&
		isAsyncContext(Reflect.get(value, "invokerStorage")),
);

export const kernelToolsStorage = kernelToolContexts.storage;

/** The active host dispatcher, including when it executes a capability captured in another session. */
export const kernelToolInvokerStorage = kernelToolContexts.invokerStorage;

function isKernelTools(value: unknown): value is ExtensionKernelTools {
	if (typeof value !== "object" || value === null) return false;
	const capabilities: unknown = Reflect.get(value, "capabilities");
	return (
		typeof capabilities === "object" &&
		capabilities !== null &&
		typeof Reflect.get(capabilities, "invokeScope") === "boolean" &&
		hasFunctions(value, ["describe", "invoke"])
	);
}

function isKernelToolInvoker(value: unknown): value is KernelToolInvoker {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "sessionId") === "string";
}

/** The kernel tools entered for this async context by any engine copy; a store missing its members reads as absent. */
export function activeKernelTools(): ExtensionKernelTools | undefined {
	const tools: unknown = kernelToolsStorage.getStore();
	return isKernelTools(tools) ? tools : undefined;
}

/** The host dispatcher identity entered for this async context by any engine copy; an ill-typed one reads as absent. */
export function activeKernelToolInvoker(): KernelToolInvoker | undefined {
	const invoker: unknown = kernelToolInvokerStorage.getStore();
	return isKernelToolInvoker(invoker) ? invoker : undefined;
}
