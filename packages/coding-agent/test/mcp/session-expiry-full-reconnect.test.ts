import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	attach,
	awaitMcpToolRegistration,
	capturingPi,
	mcpRoot,
	type RegisteredMcpTool,
	registeredTool,
	testContext,
	textContent,
} from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig } from "./fixtures/service-lifecycle.ts";
import { type HttpFixture, spawnHttpFixture } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const httpFixtures: HttpFixture[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	for (const fixture of httpFixtures.splice(0)) await fixture.cleanup();
	await cleanupRoots(cleanupTasks);
});

describe("MCP session expiry full reconnect", () => {
	it("refreshes the catalog before retrying an expired tool call", async () => {
		const { connection, tool } = await setupFixture(
			["--tools", "1", "--expire-first-tool-call", "--require-list-before-tool-call"],
			"catalog-refresh",
		);
		const initialGeneration = connection.generation;

		const result = await tool.execute(
			"tc-catalog-refresh",
			{ value: "after-expiry" },
			undefined,
			undefined,
			testContext(),
		);

		expect(textContent(result)).toBe("fixture tool_1 value=after-expiry mode=alpha");
		expect(connection.state).toBe("connected");
		expect(connection.generation).toBe(initialGeneration + 1);
		expect(reconnectCount("fx")).toBe(1);
	});

	it("suspends after one full reconnect when the renewed session also expires", async () => {
		const { connection, tool } = await setupFixture(
			["--tools", "1", "--always-expire-tool-calls"],
			"persistent-expiry",
		);
		const callTool = vi.spyOn(Client.prototype, "callTool");

		await expect(
			tool.execute("tc-persistent-expiry", { value: "still-expired" }, undefined, undefined, testContext()),
		).rejects.toThrow(/run \/mcp reconnect fx/);

		expect(connection.state).toBe("suspended");
		expect(reconnectCount("fx")).toBe(1);
		expect(callTool).toHaveBeenCalledTimes(2);
	});

	it("keeps ordinary one-shot session expiry recovery green", async () => {
		const { connection, tool } = await setupFixture(["--tools", "1", "--expire-first-tool-call"], "ordinary-expiry");

		const result = await tool.execute(
			"tc-ordinary-expiry",
			{ value: "ordinary" },
			undefined,
			undefined,
			testContext(),
		);

		expect(textContent(result)).toBe("fixture tool_1 value=ordinary mode=alpha");
		expect(connection.state).toBe("connected");
		expect(reconnectCount("fx")).toBe(1);
	});
});

async function setupFixture(
	args: string[],
	slug: string,
): Promise<{ connection: ServerConnection; tool: RegisteredMcpTool }> {
	const fixture = await spawnHttpFixture(args);
	httpFixtures.push(fixture);
	const root = mcpRoot(slug, cleanupTasks);
	setConfig(root, { fx: httpServer(fixture.url) });
	const pi = capturingPi();
	await attach(root, pi);
	await awaitMcpToolRegistration("fx");
	const connection = getMcpService().getConnection("fx");
	if (connection === undefined) throw new Error("missing fx connection");
	return { connection, tool: registeredTool(pi, "mcp_fx_tool_1") };
}

function httpServer(url: string): Record<string, unknown> {
	return {
		type: "http",
		url,
		connectTimeoutMs: 2_000,
		requestTimeoutMs: 5_000,
		startupTimeoutMs: 2_000,
	};
}

function reconnectCount(name: string): number {
	const snapshot = getMcpService()
		.getServerSnapshots()
		.find((candidate) => candidate.name === name);
	if (snapshot === undefined) throw new Error(`missing ${name} snapshot`);
	return snapshot.counters.reconnectCount;
}
