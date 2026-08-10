import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../types.ts";
import { sdkCatalog } from "../native-agent-sdk/catalog.ts";
import { streamNativeAgent } from "../native-agent-sdk/stream.ts";
import { runGrokSdk } from "./sdk-boundary.ts";

export const GROK_SDK_PROVIDER_ID = "grok-sdk";

export default function grokSdkExtension(pi: ExtensionAPI): void {
	pi.registerProvider(GROK_SDK_PROVIDER_ID, {
		baseUrl: GROK_SDK_PROVIDER_ID,
		api: GROK_SDK_PROVIDER_ID,
		apiKey: "grok-sdk-managed",
		models: sdkCatalog("xai", (modelId) => modelId.startsWith("grok-")),
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamNativeAgent(model, context, options, runGrokSdk),
	});
}
