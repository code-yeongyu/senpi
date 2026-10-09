import { expect, it, vi } from "vitest";
import { runProcess } from "../../scripts/gate-process.ts";

it("isolates codemode overrides while preserving the explicit mutation control", async () => {
	vi.stubEnv("PI_GATE_HOST", "host");
	vi.stubEnv("SENPI_CODEMODE_JS", "node");
	vi.stubEnv("SENPI_CODEMODE_GATE_MUTATE", "drop-phase");
	try {
		const result = await runProcess(
			[
				"node",
				"-e",
				`
console.log(JSON.stringify({
	host: process.env.PI_GATE_HOST,
	javascript: process.env.SENPI_CODEMODE_JS,
	mutation: process.env.SENPI_CODEMODE_GATE_MUTATE,
	required: process.env.SENPI_QA_REQUIRE_ALL_LANGUAGES,
}));
`,
			],
			process.cwd(),
		);
		expect(result.exitCode).toBe(0);
		const output: unknown = JSON.parse(result.stdout);
		expect(output).toEqual({ mutation: "drop-phase", required: "1" });
	} finally {
		vi.unstubAllEnvs();
	}
});
