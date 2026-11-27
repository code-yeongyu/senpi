import { AsyncLocalStorage } from "node:async_hooks";

export const scope = new AsyncLocalStorage<string>();
