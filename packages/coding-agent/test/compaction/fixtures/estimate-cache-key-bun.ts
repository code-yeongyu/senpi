import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateCacheKey, serializeForEstimate } from "../../../src/core/compaction/estimate-cache-key.ts";

const prose = (chars: number): string => "abcd".repeat(chars / 4);
const message = { role: "user", content: [{ type: "text", text: prose(4000) }], timestamp: 1 } as AgentMessage;
const serialized = serializeForEstimate(message) ?? "";
const block = (message as { content: { text: string }[] }).content[0]!;
const swapped = prose(3996) + "wxyz"; // same length, different text
block.text = swapped;
console.log(
	JSON.stringify({
		runtime: "Bun" in globalThis ? "bun" : "node",
		keyIsText: estimateCacheKey(serialized) === serialized,
		keyLength: estimateCacheKey(serialized).length,
		sameLengthKeysDiffer: estimateCacheKey(serialized) !== estimateCacheKey(serializeForEstimate(message) ?? ""),
	}),
);
