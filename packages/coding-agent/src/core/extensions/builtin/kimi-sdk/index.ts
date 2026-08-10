import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../types.ts";
import { sdkCatalog } from "../native-agent-sdk/catalog.ts";
import { streamNativeAgent } from "../native-agent-sdk/stream.ts";
import { runKimiSdk } from "./sdk-boundary.ts";

export const KIMI_SDK_PROVIDER_ID = "kimi-sdk";

export default function kimiSdkExtension(pi: ExtensionAPI): void {
	pi.registerProvider(KIMI_SDK_PROVIDER_ID, {
		baseUrl: KIMI_SDK_PROVIDER_ID,
		api: KIMI_SDK_PROVIDER_ID,
		apiKey: "kimi-sdk-managed",
		models: sdkCatalog("kimi-coding"),
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamNativeAgent(model, context, options, runKimiSdk),
	});
}
