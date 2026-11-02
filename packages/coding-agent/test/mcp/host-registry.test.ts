import { afterEach, describe, expect, it } from "vitest";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import {
	HostMcpRegistry,
	HostMcpRegistryError,
	shareable,
} from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { serverConfig } from "./fixtures/reconnect.ts";
import { attach, cleanupRoots, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const registries: HostMcpRegistry[] = [];
const services: McpService[] = [];
const key = "fixture\0config-hash";

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose("quit")));
	for (const registry of registries.splice(0)) {
		for (const owner of [...registry.forEachOwner(key)]) await registry.detach(key, owner);
	}
	await cleanupRoots(cleanupTasks);
});

function fixture() {
	const root = makeRoot("host-registry", cleanupTasks);
	const config = serverConfig();
	const registry = new HostMcpRegistry();
	registries.push(registry);
	const factory = () =>
		new ServerConnection({
			serverName: "fixture",
			config,
			logger: createMcpLogger("fixture", { logDir: root.agentDir }),
		});
	return { registry, factory, config };
}

// senpi#1915: sharing is an explicit seam, never the production default.
describe("HostMcpRegistry", () => {
	it("isolates services using one registry through reload and disposal", async () => {
		const root = makeRoot("host-registry-services", cleanupTasks);
		setConfig(root, { fx: { ...stdioServer(["--tools", "1"]), env: { PROJECT_CWD: root.cwd }, lifecycle: "eager" } });
		const registry = new HostMcpRegistry();
		const first = new McpService({ mcpRegistry: registry });
		const second = new McpService({ mcpRegistry: registry });
		services.push(first, second);

		await attach(first, root, "startup");
		await attach(second, root, "startup");
		expect(await first.whenAttachSettled(10_000)).toBe("settled");
		expect(await second.whenAttachSettled(10_000)).toBe("settled");
		const a = first.getConnection("fx");
		const b = second.getConnection("fx");
		if (!a || !b) throw new Error("missing fixture connections");
		expect(registry.size()).toBe(2);
		expect(a).not.toBe(b);
		expect(a.getRootPid()).not.toBe(b.getRootPid());

		await attach(first, root, "reload");
		expect(first.getConnection("fx")).toBe(a);
		expect(registry.size()).toBe(2);
		setConfig(root, {});
		await attach(first, root, "reload");
		expect(a.state).toBe("disabled");
		expect(registry.size()).toBe(1);
		expect(b.state).toBe("connected");
		expect((await b.client.callTool({ name: "tool_1", arguments: { value: "survivor" } })).isError).not.toBe(true);
		await second.dispose("quit");
		expect(registry.size()).toBe(0);
	});

	it("keeps different owners isolated with sharing off", async () => {
		const { registry, factory } = fixture();
		const a = {};
		const b = {};
		const first = registry.attach(key, a, factory);
		const second = registry.attach(key, b, factory);

		expect(first).not.toBe(second);
		expect(registry.size()).toBe(2);
		expect([...registry.forEachOwner(key)]).toEqual([a, b]);
		await registry.detach(key, a);
		expect(first.state).toBe("disabled");
		expect(second.state).toBe("idle");
		expect(registry.size()).toBe(1);
		await registry.detach(key, b);
		expect(second.state).toBe("disabled");
		expect(registry.size()).toBe(0);
	});

	it("shares only explicit shareable attaches and disposes at the final owner", async () => {
		const { registry, factory } = fixture();
		const a = {};
		const b = {};
		const first = registry.attach(key, a, factory, true);
		const second = registry.attach(key, b, factory, true);

		expect(second).toBe(first);
		expect(registry.size()).toBe(1);
		await registry.detach(key, a);
		expect(first.state).toBe("idle");
		expect([...registry.forEachOwner(key)]).toEqual([b]);
		await registry.detach(key, b);
		expect(first.state).toBe("disabled");
		expect(registry.size()).toBe(0);
	});

	it("counts repeated attaches by the same owner", async () => {
		const { registry, factory } = fixture();
		const owner = {};
		const connection = registry.attach(key, owner, factory);
		expect(registry.attach(key, owner, factory)).toBe(connection);

		await registry.detach(key, owner);
		expect(connection.state).toBe("idle");
		expect([...registry.forEachOwner(key)]).toEqual([owner]);
		await registry.detach(key, owner);
		expect(connection.state).toBe("disabled");
	});

	it("rejects an unknown owner without changing another owner's connection", async () => {
		const { registry, factory } = fixture();
		const owner = {};
		const connection = registry.attach(key, owner, factory);

		await expect(registry.detach(key, {})).rejects.toBeInstanceOf(HostMcpRegistryError);
		await expect(registry.detach("absent", owner)).rejects.toMatchObject({ code: "unknown_owner" });
		expect(registry.size()).toBe(1);
		expect(connection.state).toBe("idle");
	});

	it("does not retain a failed factory or join private entries", () => {
		const { registry, factory } = fixture();
		const cause = new Error("factory failure");
		expect(() =>
			registry.attach(key, {}, () => {
				throw cause;
			}),
		).toThrow(cause);
		expect(registry.size()).toBe(0);
		const privateConnection = registry.attach(key, {}, factory);
		const sharedConnection = registry.attach(key, {}, factory, true);
		expect(sharedConnection).not.toBe(privateConnection);
		expect(registry.size()).toBe(2);
	});

	it("allows HTTP and independent stdio but excludes session-dependent stdio", () => {
		const { config } = fixture();
		expect(shareable(config)).toBe(true);
		expect(shareable({ ...config, type: "http", url: "http://127.0.0.1:1/mcp" })).toBe(true);
		expect(shareable({ ...config, env: { OMO_AST_GREP_PROJECT_CWD: process.cwd() } })).toBe(false);
	});
});
