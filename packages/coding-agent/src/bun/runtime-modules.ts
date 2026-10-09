import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
	setBedrockProviderModule,
	setCursorAgentProviderModule,
	setDevinAgentProviderModule,
} from "@earendil-works/pi-ai/compat";
import { cursorAgentProviderModule } from "@earendil-works/pi-ai/cursor-agent-provider";
import { devinProviderModule } from "@earendil-works/pi-ai/devin-provider";

let registered = false;

/** Register bundled Node-only providers and OAuth flows once in each Bun isolate. */
export function registerBunRuntimeModules(): void {
	if (registered) return;
	setBedrockProviderModule(bedrockProviderModule);
	setCursorAgentProviderModule(cursorAgentProviderModule);
	setDevinAgentProviderModule(devinProviderModule);
	registerBunOAuthFlows();
	registered = true;
}
