// Regression: senpi#4597. Extensions written against the upstream Pi 1.x MCP API (pi-mcp-adapter
// 5.1.0) probe `pi.registerMcpServer` and then call `pi.getMcpServers()` unconditionally, handle
// `mcp_servers_change`, and call `pi.unregisterMcpServer()`. senpi exposed only `registerMcpServer`,
// so such an extension threw `pi.getMcpServers is not a function` at load.

import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionFactory,
	McpServersChangeEvent,
	RegisteredMcpServer,
} from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

const open = new Set<Harness>();

afterEach(() => {
	for (const harness of open) harness.cleanup();
	open.clear();
});

async function openSession(factories: HarnessOptions["extensionFactories"]): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: factories });
	open.add(harness);
	return harness;
}

function stdio(command: string, args?: string[]): { type: "stdio"; command: string; args?: string[] } {
	return args === undefined ? { type: "stdio", command } : { type: "stdio", command, args };
}

function startSession(harness: Harness): Promise<unknown> {
	return harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
}

describe("senpi#4597: upstream MCP extension API", () => {
	it("binds an extension that probes registerMcpServer and reads getMcpServers at load, on session_start and when registering (pi-mcp-adapter 5.1.0 index.ts:65-67, :912, :1329)", async () => {
		const seen: { load?: RegisteredMcpServer[]; start?: RegisteredMcpServer[]; register?: boolean } = {};
		const adapter: ExtensionFactory = (pi) => {
			// index.ts:65-67: Pi is MCP-capable when registerMcpServer exists.
			if (typeof pi.registerMcpServer !== "function") throw new Error("fixture expects registerMcpServer");
			// index.ts:912: the register path checks the name against Pi's registrations.
			const registeredWithPi = (name: string): boolean => pi.getMcpServers().some((server) => server.name === name);
			seen.load = pi.getMcpServers();
			pi.on("mcp_servers_change", () => {});
			pi.on("session_start", () => {
				// index.ts:1329: registrations made while extensions loaded.
				seen.start = pi.getMcpServers();
				seen.register = registeredWithPi("docs");
			});
		};
		const harness = await openSession([
			{ name: "docs", factory: (pi) => pi.registerMcpServer("docs", stdio("docs-server")) },
			{ name: "adapter", factory: adapter },
		]);
		await startSession(harness);

		expect(seen.load?.map((server) => server.name)).toEqual(["docs"]);
		expect(seen.start?.map((server) => server.name)).toEqual(["docs"]);
		expect(seen.register).toBe(true);
	});

	it("getMcpServers lists every registered server in registration order as {name, config, extensionPath} copies", async () => {
		let listed: RegisteredMcpServer[] | undefined;
		let relisted: RegisteredMcpServer[] | undefined;
		const harness = await openSession([
			{
				name: "a",
				factory: (pi) => {
					pi.registerMcpServer("alpha", stdio("a", ["x"]));
					pi.registerMcpServer("beta", stdio("b"));
				},
			},
			{ name: "b", factory: (pi) => pi.registerMcpServer("gamma", { type: "http", url: "http://localhost:3000" }) },
			{
				name: "reader",
				factory: (pi) => {
					pi.on("session_start", () => {
						listed = pi.getMcpServers();
						const first = listed[0];
						if (first?.config.type === "stdio") first.config.command = "mutated";
						relisted = pi.getMcpServers();
					});
				},
			},
		]);
		await startSession(harness);

		expect(relisted).toEqual([
			{ name: "alpha", config: { type: "stdio", command: "a", args: ["x"] }, extensionPath: "<inline:a>" },
			{ name: "beta", config: { type: "stdio", command: "b" }, extensionPath: "<inline:a>" },
			{ name: "gamma", config: { type: "http", url: "http://localhost:3000" }, extensionPath: "<inline:b>" },
		]);
		expect(Object.keys(relisted?.[0] ?? {}).sort()).toEqual(["config", "extensionPath", "name"]);
		expect(listed?.[0]?.config.command).toBe("mutated");
	});

	it("unregisterMcpServer removes only the calling extension's own registration", async () => {
		let after: RegisteredMcpServer[] | undefined;
		const harness = await openSession([
			{ name: "a", factory: (pi) => pi.registerMcpServer("a1", stdio("a")) },
			{
				name: "b",
				factory: (pi) => {
					pi.registerMcpServer("b1", stdio("b"));
					pi.on("session_start", () => {
						pi.unregisterMcpServer("a1");
						pi.unregisterMcpServer("b1");
						after = pi.getMcpServers();
					});
				},
			},
		]);
		await startSession(harness);

		expect(after?.map((server) => server.name)).toEqual(["a1"]);
	});

	it("mcp_servers_change fires after bind on every registry change with the full list, never during load", async () => {
		const events: McpServersChangeEvent[] = [];
		const gotTwo = Promise.withResolvers<void>();
		const harness = await openSession([
			{
				name: "claimant",
				factory: (pi) => {
					pi.on("mcp_servers_change", (event) => {
						events.push(event);
						if (events.length === 2) gotTwo.resolve();
					});
				},
			},
			{
				name: "registrar",
				factory: (pi) => {
					pi.registerMcpServer("early", stdio("early"));
					pi.on("session_start", () => {
						pi.registerMcpServer("late", stdio("late"));
						pi.unregisterMcpServer("early");
					});
				},
			},
		]);
		expect(events).toEqual([]);

		await startSession(harness);
		await gotTwo.promise;

		const early = { name: "early", config: stdio("early"), extensionPath: "<inline:registrar>" };
		const late = { name: "late", config: stdio("late"), extensionPath: "<inline:registrar>" };
		expect(events).toEqual([
			{ type: "mcp_servers_change", servers: [early, late] },
			{ type: "mcp_servers_change", servers: [late] },
		]);
	});
});
