import { defineConfig } from "vitest/config";
import { dotReporters } from "../../scripts/vitest-dot-reporters.mjs";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: dotReporters(),
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
