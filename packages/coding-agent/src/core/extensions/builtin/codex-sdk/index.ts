import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../types.ts";
import { sdkCatalog } from "../native-agent-sdk/catalog.ts";
import { streamNativeAgent } from "../native-agent-sdk/stream.ts";
import { runCodexSdk } from "./sdk-boundary.ts";

export const CODEX_SDK_PROVIDER_ID = "codex-sdk";

export default function codexSdkExtension(pi: ExtensionAPI): void {
	pi.registerProvider(CODEX_SDK_PROVIDER_ID, {
		baseUrl: CODEX_SDK_PROVIDER_ID,
		api: CODEX_SDK_PROVIDER_ID,
		apiKey: "codex-sdk-managed",
		models: sdkCatalog("openai-codex"),
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamNativeAgent(model, context, options, runCodexSdk),
	});
}
