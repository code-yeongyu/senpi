import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const senpiSrcIndex = fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcProviderScope = fileURLToPath(new URL("../ai/src/node/provider-scope.ts", import.meta.url));
const aiSrcBedrockProvider = fileURLToPath(new URL("../ai/src/bedrock-provider.ts", import.meta.url));
const aiSrcBunOAuth = fileURLToPath(new URL("../ai/src/bun-oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
const ptySrcIndex = fileURLToPath(new URL("../pty/src/index.ts", import.meta.url));
const clientSrcIndex = fileURLToPath(new URL("../client/src/index.ts", import.meta.url));
const protocolSrcIndex = fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 30_000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{ find: /^@code-yeongyu\/senpi$/, replacement: senpiSrcIndex },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-ai\/node\/provider-scope$/, replacement: aiSrcProviderScope },
			{ find: /^@earendil-works\/pi-ai\/bedrock-provider$/, replacement: aiSrcBedrockProvider },
			{ find: /^@earendil-works\/pi-ai\/bun-oauth$/, replacement: aiSrcBunOAuth },
			{
				find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
				replacement: fileURLToPath(new URL("../ai/src/providers/$1.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-ai\/utils\/(.+)$/,
				replacement: fileURLToPath(new URL("../ai/src/utils/$1.ts", import.meta.url)),
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-pty$/, replacement: ptySrcIndex },
			{ find: /^@earendil-works\/pi-client$/, replacement: clientSrcIndex },
			{ find: /^@earendil-works\/pi-protocol$/, replacement: protocolSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
