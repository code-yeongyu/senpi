import type { ProviderEnv } from "../types.ts";
import type { VertexAdcAccess } from "./google-vertex-adc.ts";

export type { VertexAdcAccess } from "./google-vertex-adc.ts";

/** Lazily loads google-auth-library so importing callers do not pay for it until a request is made. */
export async function getVertexAdcAccess(options?: { project?: string; env?: ProviderEnv }): Promise<VertexAdcAccess> {
	const module = await import("./google-vertex-adc.ts");
	return module.getVertexAdcAccess(options);
}
