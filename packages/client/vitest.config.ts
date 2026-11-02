import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { dotReporters } from "../../scripts/vitest-dot-reporters.mjs";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: dotReporters(),
	},
	resolve: {
		conditions: ["source"],
		alias: {
			"@earendil-works/pi-protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
		},
	},
	ssr: { resolve: { conditions: ["source"] } },
});
