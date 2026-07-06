import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertProcessDead,
	connectToHttpFixture,
	connectToStdioFixture,
	spawnHttpFixture,
	stdioFixtureCommand,
} from "./fixtures/spawn-fixture.ts";

const clients: Client[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const client of clients.splice(0)) {
		await client.close().catch(() => undefined);
	}
	for (const cleanup of cleanupTasks.splice(0).reverse()) {
		await cleanup();
	}
});

describe("MCP fixture servers", () => {
	it("serves generated tools over stdio and preserves isError results", async () => {
		const { client, transport } = await connectToStdioFixture(["--tools", "4", "--iserror-tool"]);
		clients.push(client);
		const pid = transport.pid;

		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2", "tool_3", "tool_4", "iserror_tool"]);
		expect(listed.tools[0]?.inputSchema.properties).toHaveProperty("mode");

		const result = await client.callTool({ name: "tool_2", arguments: { value: "ok", mode: "alpha" } });
		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "fixture tool_2 value=ok mode=alpha" }]);

		const errorResult = await client.callTool({ name: "iserror_tool", arguments: {} });
		expect(errorResult.isError).toBe(true);
		expect(errorResult.content).toEqual([{ type: "text", text: "fixture isError result" }]);

		await client.close();
		clients.pop();
		if (pid === null) {
			throw new Error("stdio fixture transport did not expose a pid");
		}
		await assertProcessDead(pid);
	});

	it("serves generated tools over streamable HTTP and expires sessions with 404", async () => {
		const fixture = await spawnHttpFixture(["--tools", "3", "--expire-session"]);
		cleanupTasks.push(fixture.cleanup);
		const { client, transport } = await connectToHttpFixture(fixture.url);
		clients.push(client);

		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2", "tool_3"]);
		expect(transport.sessionId).toMatch(/^fx-/);

		await expect(client.callTool({ name: "tool_1", arguments: {} })).rejects.toMatchObject({ code: 404 });
	});

	it("times out a wedged stdio fixture under one second and reaps the process", async () => {
		const started = performance.now();
		const controller = new AbortController();
		const transport = new StdioClientTransport({
			command: stdioFixtureCommand().command,
			args: [...stdioFixtureCommand().args, "--wedge"],
			stderr: "pipe",
		});
		const client = new Client({ name: "fixture-selftest", version: "1.0.0" });
		clients.push(client);

		const timer = setTimeout(() => controller.abort(), 500);
		await expect(client.connect(transport, { signal: controller.signal, timeout: 5000 })).rejects.toThrow();
		clearTimeout(timer);
		expect(performance.now() - started).toBeLessThan(1000);

		const pid = transport.pid;
		await client.close().catch(() => undefined);
		clients.pop();
		if (pid !== null) {
			await assertProcessDead(pid);
		}
	});

	it("surfaces EOF when a stdio fixture crashes after the first call", async () => {
		const { client, transport } = await connectToStdioFixture(["--tools", "1", "--crash-after", "1"]);
		clients.push(client);
		const pid = transport.pid;
		if (pid === null) {
			throw new Error("stdio fixture transport did not expose a pid");
		}

		const first = await client.callTool({ name: "tool_1", arguments: {} });
		expect(first.isError).not.toBe(true);

		await assertProcessDead(pid);
		await expect(client.callTool({ name: "tool_1", arguments: {} })).rejects.toThrow(
			/closed|Connection|EOF|Not connected/i,
		);
	});
});
