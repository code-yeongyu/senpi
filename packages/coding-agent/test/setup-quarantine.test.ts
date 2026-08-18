import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { resolveQuarantineAgentDir } from "./support/quarantine.ts";

describe("test quarantine resolver", () => {
	test("overrides an inherited SENPI_CODING_AGENT_DIR (omo launcher dirty env)", () => {
		const inherited = "/Users/yeongyu/.omo/agent";
		const result = resolveQuarantineAgentDir({ SENPI_CODING_AGENT_DIR: inherited });

		expect(result).toBeDefined();
		expect(result).not.toBe(inherited);
		expect(result).toContain(tmpdir());
	});

	test("honors SENPI_TEST_USE_REAL_AGENT_DIR=1 opt-in", () => {
		const inherited = "/Users/yeongyu/.omo/agent";
		const result = resolveQuarantineAgentDir({
			SENPI_CODING_AGENT_DIR: inherited,
			SENPI_TEST_USE_REAL_AGENT_DIR: "1",
		});

		expect(result).toBe(inherited);
	});

	test("quarantines when no env is set", () => {
		const result = resolveQuarantineAgentDir({});

		expect(result).toBeDefined();
		expect(result).toContain(tmpdir());
	});
});
