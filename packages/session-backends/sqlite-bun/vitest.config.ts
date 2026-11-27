import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentConformance = fileURLToPath(new URL("../../agent/src/conformance/index.ts", import.meta.url));
const agentWin32Sim = fileURLToPath(new URL("../../agent/src/testing/win32-sim.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-agent-core\/conformance$/, replacement: agentConformance },
			{ find: /^@earendil-works\/pi-agent-core\/testing\/win32-sim$/, replacement: agentWin32Sim },
		],
	},
});
