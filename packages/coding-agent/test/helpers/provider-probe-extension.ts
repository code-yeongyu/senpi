import { bedrockConverseStreamApi, cursorAgentApi, devinAgentApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

/** The extension must use the binary's lazy API instances, not external provider implementations. */
export default function providerProbeExtension(pi: ExtensionAPI): void {
	const apis = [
		["bedrock-converse-stream", bedrockConverseStreamApi],
		["cursor-agent", cursorAgentApi],
		["devin-agent", devinAgentApi],
	] as const;
	for (const [index, [api, createApi]] of apis.entries()) {
		const baseUrl = new URL(process.env[`SENPI_PROBE_URL_${index}`] ?? "").href;
		pi.registerProvider(`probe-${index}`, {
			api,
			baseUrl,
			apiKey: "local-probe-key",
			streamSimple: createApi().streamSimple,
			models: [
				{
					id: `probe-${index}`,
					name: `Probe ${index}`,
					reasoning: false,
					input: ["text"],
					contextWindow: 200000,
					maxTokens: 256,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
	}
}
