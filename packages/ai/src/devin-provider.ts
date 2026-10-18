import { stream, streamSimple } from "./api/devin-agent.ts";

/** Static implementation for standalone Bun binaries. */
export const devinProviderModule = { stream, streamSimple };
