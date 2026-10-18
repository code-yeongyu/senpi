import { AsyncLocalStorage } from "node:async_hooks";

export const kernelToolCallContext = new AsyncLocalStorage();

export function inKernelToolInvoke() {
	return kernelToolCallContext.getStore() != null;
}
