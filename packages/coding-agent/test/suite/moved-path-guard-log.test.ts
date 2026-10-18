import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	flushGuardLog,
	guardLogPath,
	logGuardEvent,
} from "../../src/core/extensions/builtin/moved-path-guard/guard-log.ts";

// code-yeongyu/senpi#2898 third review L-b: the guard log is bounded (one rotation at 1 MiB), says each reason once,
// and never throws into the tool call that logs, even when its own location cannot be computed.

const agentDirFails = vi.hoisted(() => ({ value: false }));

vi.mock("../../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/config.ts")>();
	return {
		...actual,
		getAgentDir: () => {
			if (agentDirFails.value) throw new Error("ENOENT: process.cwd failed");
			return actual.getAgentDir();
		},
	};
});

function lines(): Array<Record<string, unknown>> {
	if (!existsSync(guardLogPath())) return [];
	return readFileSync(guardLogPath(), "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("moved-path-guard log (#2898)", () => {
	afterEach(async () => {
		agentDirFails.value = false;
		await flushGuardLog();
		rmSync(guardLogPath(), { force: true });
		rmSync(`${guardLogPath()}.1`, { force: true });
	});

	it("logs a bound once per reason, whatever the count", async () => {
		logGuardEvent("debug", "call_bound_reached", { bound: "paths-once-test", count: "70" });
		logGuardEvent("debug", "call_bound_reached", { bound: "paths-once-test", count: "71" });
		await flushGuardLog();

		expect(lines().filter((line) => line.bound === "paths-once-test")).toHaveLength(1);
	});

	it("rotates the log once it would pass 1 MiB", async () => {
		mkdirSync(dirname(guardLogPath()), { recursive: true });
		writeFileSync(guardLogPath(), `${"x".repeat(1024 * 1024)}\n`);

		logGuardEvent("debug", "call_bound_reached", { bound: "rotation-test" });
		await flushGuardLog();

		expect(statSync(`${guardLogPath()}.1`).size).toBeGreaterThan(1024 * 1024);
		expect(lines().map((line) => line.bound)).toEqual(["rotation-test"]);
	});

	it("never throws when its own location cannot be computed", async () => {
		agentDirFails.value = true;

		expect(() => logGuardEvent("warn", "marker_newer", { file: "/x", schemaVersion: "9" })).not.toThrow();
		await expect(flushGuardLog()).resolves.toBeUndefined();
	});
});
