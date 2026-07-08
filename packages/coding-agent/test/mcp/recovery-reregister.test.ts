// #147: a server that crashes while the one-shot startup exposure is still in
// flight used to recover its CONNECTION (reconnect controller) but never its
// EXPOSURE — the session had zero tools for the rest of its life (first
// observed on CI via the idle-test diagnostics: state=connected,
// toolRegistered=false, on a branch that predated W4). The W4 list_changed
// wiring closed the gap as a side effect: every successful connect fires
// markToolsChanged -> handleServerToolsChanged -> registerDirectTools. This
// test pins that recovery-exposure contract so it cannot silently regress.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { attach, capturingPi, mcpRoot as makeMcpRoot } from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, type TestRoot, waitForCondition } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(slug, cleanupTasks);
}

/** Wrapper that crashes while modeFile says "fail", then boots the real fixture. */
function writeCrashingWrapper(root: TestRoot, modeFile: string): string {
	const wrapper = join(root.agentDir, "crashy-wrapper.mjs");
	mkdirSync(dirname(wrapper), { recursive: true });
	writeFileSync(modeFile, "fail\n");
	const fixture = pathToFileURL(join(import.meta.dirname, "fixtures", "stdio-server.ts")).href;
	writeFileSync(
		wrapper,
		`
import { readFileSync } from "node:fs";
if (readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() === "fail") process.exit(44);
await import(${JSON.stringify(fixture)});
`,
	);
	chmodSync(wrapper, 0o755);
	return wrapper;
}

describe("recovery re-registration (#147)", () => {
	it("exposes tools after the reconnect controller recovers a crash-at-startup server", async () => {
		const root = mcpRoot("recovery-reregister");
		const modeFile = join(root.agentDir, "wrapper-mode.txt");
		const wrapper = writeCrashingWrapper(root, modeFile);
		setConfig(root, {
			fx: {
				type: "stdio",
				command: process.execPath,
				args: [wrapper, "--tools", "2"],
				connectTimeoutMs: 5000,
			},
		});
		const pi = capturingPi();
		// Initial attach: every spawn crashes, so the one-shot startup exposure
		// registers nothing and the connection goes degraded.
		await attach(root, pi);
		expect(pi.registeredTools.filter((name) => name.startsWith("mcp_fx_"))).toEqual([]);

		// Heal the server; the reconnect controller's real backoff timers respawn
		// it. With the fix, recovery re-runs registration and the tools surface.
		writeFileSync(modeFile, "ok\n");
		await waitForCondition(
			() => pi.registeredTools.includes("mcp_fx_tool_1") && pi.activeTools.includes("mcp_fx_tool_1"),
			15_000,
		);
		expect(getMcpService().getConnection("fx")?.state).toBe("connected");
	});
});
