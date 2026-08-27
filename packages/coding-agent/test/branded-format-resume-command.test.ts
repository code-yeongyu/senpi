import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete process.env.SENPI_BRAND;
	vi.resetModules();
});

describe("branded formatResumeCommand", () => {
	it("uses the literal branded executable for default and custom session dirs", async () => {
		process.env.SENPI_BRAND = JSON.stringify({
			name: "OmO",
			configDir: ".omo",
			flatLayout: false,
			envPrefix: "OMO",
			userAgent: "omo",
			command: "omo",
		});
		vi.resetModules();
		const { APP_COMMAND } = await import("../src/config.ts");
		const { formatResumeCommand } = await import("../src/modes/interactive/interactive-mode.ts");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const dir = mkdtempSync(join(tmpdir(), "senpi-brand-command-"));
		dirs.push(dir);
		const file = join(dir, "session.jsonl");
		writeFileSync(file, "\n");
		const manager = {
			isPersisted: () => true,
			getSessionFile: () => file,
			getSessionId: () => "test-session",
			getSessionDir: () => "/tmp/custom-omo-sessions",
			usesDefaultSessionDir: () => false,
		} as unknown as SessionManager;
		expect(APP_COMMAND).toBe("omo");
		expect(formatResumeCommand(manager)).toBe("omo --session-dir /tmp/custom-omo-sessions --session test-session");
	});
});
