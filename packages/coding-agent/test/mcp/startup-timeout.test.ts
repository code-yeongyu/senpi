import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MCP_STARTUP_RACE_MS,
	MCP_STARTUP_TIMEOUT_ENV,
	resolveMcpStartupTimeoutMs,
} from "../../src/core/extensions/builtin/mcp/startup-race.ts";

describe("resolveMcpStartupTimeoutMs", () => {
	let original: string | undefined;

	beforeEach(() => {
		original = process.env[MCP_STARTUP_TIMEOUT_ENV];
		delete process.env[MCP_STARTUP_TIMEOUT_ENV];
	});

	afterEach(() => {
		if (original === undefined) delete process.env[MCP_STARTUP_TIMEOUT_ENV];
		else process.env[MCP_STARTUP_TIMEOUT_ENV] = original;
	});

	it("falls back to the default race window when nothing is configured", () => {
		expect(resolveMcpStartupTimeoutMs(undefined)).toBe(MCP_STARTUP_RACE_MS);
	});

	it("honors the configured value from settings", () => {
		expect(resolveMcpStartupTimeoutMs(500)).toBe(500);
	});

	it("lets the env override win over the configured value", () => {
		process.env[MCP_STARTUP_TIMEOUT_ENV] = "750";
		expect(resolveMcpStartupTimeoutMs(500)).toBe(750);
	});

	it("ignores a non-numeric env value and keeps the configured value", () => {
		process.env[MCP_STARTUP_TIMEOUT_ENV] = "not-a-number";
		expect(resolveMcpStartupTimeoutMs(500)).toBe(500);
	});

	it("ignores a negative env value and keeps the configured value", () => {
		process.env[MCP_STARTUP_TIMEOUT_ENV] = "-10";
		expect(resolveMcpStartupTimeoutMs(500)).toBe(500);
	});

	it("accepts 0 to make the startup window non-blocking", () => {
		process.env[MCP_STARTUP_TIMEOUT_ENV] = "0";
		expect(resolveMcpStartupTimeoutMs(500)).toBe(0);
	});
});
