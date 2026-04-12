import { describe, expect, test, vi } from "vitest";
import { printHelp } from "../src/cli/args.js";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.js";

describe("senpi branding", () => {
	test("uses senpi as the runtime app identity", () => {
		// given

		// when
		const branding = {
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
			envAgentDir: ENV_AGENT_DIR,
		};

		// then
		expect(branding).toEqual({
			appName: "senpi",
			configDirName: ".senpi",
			envAgentDir: "SENPI_CODING_AGENT_DIR",
		});
	});

	test("prints senpi in the top-level help output", () => {
		// given
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			// when
			printHelp();
			const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");

			// then
			expect(output).toContain("senpi - AI coding assistant");
			expect(output).toContain("senpi [options] [@files...] [messages...]");
			expect(output).toContain("senpi install <source> [-l]");
			expect(output).toContain("~/.senpi/agent");
		} finally {
			logSpy.mockRestore();
		}
	});
});
