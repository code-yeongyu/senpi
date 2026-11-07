import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { dotReporters } from "../../../scripts/vitest-dot-reporters.mjs";

const agentConformance = fileURLToPath(new URL("../../agent/src/conformance/index.ts", import.meta.url));
const agentWin32Sim = fileURLToPath(new URL("../../agent/src/testing/win32-sim.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: dotReporters(),
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-agent-core\/conformance$/, replacement: agentConformance },
			{ find: /^@earendil-works\/pi-agent-core\/testing\/win32-sim$/, replacement: agentWin32Sim },
		],
	},
});
