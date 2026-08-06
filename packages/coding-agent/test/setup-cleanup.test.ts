import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import globalSetup from "./global-setup.ts";

describe("Vitest agent-directory quarantine", () => {
	it("removes its temporary root when the worker exits", () => {
		const setupUrl = new URL("./setup.ts", import.meta.url).href;
		const script = `await import(${JSON.stringify(setupUrl)}); console.log(process.env.SENPI_CODING_AGENT_DIR);`;
		const env = { ...process.env };
		delete env.SENPI_CODING_AGENT_DIR;
		delete env.SENPI_VITEST_QUARANTINE_ROOT;

		const child = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "--eval", script],
			{
				encoding: "utf8",
				env,
			},
		);

		expect(child.status, child.stderr).toBe(0);
		const agentDir = child.stdout.trim();
		expect(agentDir).toContain("senpi-vitest-");
		expect(existsSync(dirname(agentDir))).toBe(false);
	});
	it("removes every worker quarantine through global teardown", () => {
		const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
		const originalRoot = process.env.SENPI_VITEST_QUARANTINE_ROOT;
		let teardown: (() => void) | undefined;
		try {
			delete process.env.SENPI_CODING_AGENT_DIR;
			delete process.env.SENPI_VITEST_QUARANTINE_ROOT;
			teardown = globalSetup();
			const quarantineRoot = process.env.SENPI_VITEST_QUARANTINE_ROOT;
			expect(quarantineRoot).toBeTypeOf("string");
			expect(existsSync(quarantineRoot!)).toBe(true);

			teardown?.();
			teardown = undefined;
			expect(existsSync(quarantineRoot!)).toBe(false);
			expect(process.env.SENPI_VITEST_QUARANTINE_ROOT).toBeUndefined();
		} finally {
			teardown?.();
			if (originalAgentDir === undefined) {
				delete process.env.SENPI_CODING_AGENT_DIR;
			} else {
				process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
			}
			if (originalRoot === undefined) {
				delete process.env.SENPI_VITEST_QUARANTINE_ROOT;
			} else {
				process.env.SENPI_VITEST_QUARANTINE_ROOT = originalRoot;
			}
		}
	});
});
