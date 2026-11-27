/** senpi#7512: a connect that times out after the startup race backgrounded it still SETTLES the attach. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

describe("MCP attach with a connect that times out (senpi#7512)", () => {
	it("settles the attach and leaves the server degraded with the connect timeout", async () => {
		// Given: an eager server that starts slower than its connect timeout, so the startup race backgrounds the connect.
		const root = makeRoot("startup-connect-timeout", cleanupTasks);
		setConfig(root, {
			fx: { ...stdioServer(["--tools", "1", "--slow-start", "1500"]), connectTimeoutMs: 300, lifecycle: "eager" },
		});

		// When: the session attaches and a consumer waits for the deferred attach.
		await getMcpService().attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			capturingPi(),
			{ agentDir: root.agentDir },
		);
		const settle = await getMcpService().whenAttachSettled(10_000);

		// Then: a failed connect still settles the attach, so readiness is the server's state, not the settle; the
		// server reports the timeout instead of being connected.
		const fx = getMcpService().getConnection("fx");
		expect({ settle, state: fx?.state, error: fx?.lastError?.message }).toEqual({
			settle: "settled",
			state: "degraded",
			error: expect.stringMatching(/timed out during connect/),
		});
	});
});
