// MCP resources (todo 39): utility tools registered only when a server lists
// resources; read maps text AND binary contents (guarded); resource-updated
// notifications ride the tools-changed refresh path; @mcp: mentions inline the
// resource body while malformed/unknown mentions pass through with a notice.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandMcpResourceMentions,
	type McpResourceServer,
	readMcpResourceAsText,
	subscribeMcpResourceUpdated,
} from "../../src/core/extensions/builtin/mcp/resources.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	attach,
	awaitMcpToolRegistration,
	capturingPi,
	mcpRoot as makeMcpRoot,
	registeredTool,
	testContext,
	textContent,
} from "./fixtures/register-call.ts";
import { cleanupRoots, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

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

function fakeBinaryServer(): McpResourceServer {
	return {
		connection: {
			client: {
				readResource: async () => ({
					contents: [{ blob: "QUFBQQ==", mimeType: "image/png", uri: "fake://bin" }],
				}),
			},
		},
		resources: [{ name: "bin", uri: "fake://bin" }],
		server: "fake",
	} as never;
}

describe("mcp resources", () => {
	it("registers utility tools only with resources present; list+read round-trip", async () => {
		const root = mcpRoot("res-live");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");

		expect(pi.getActiveTools()).toContain("mcp_list_resources");
		const list = await registeredTool(pi, "mcp_list_resources").execute(
			"t1",
			{},
			undefined,
			undefined,
			testContext(),
		);
		expect(textContent(list)).toContain("@mcp:fx/fixture://resource/one");

		const read = await registeredTool(pi, "mcp_read_resource").execute(
			"t2",
			{ server: "fx", uri: "fixture://resource/one" },
			undefined,
			undefined,
			testContext(),
		);
		expect(textContent(read)).toBe("resource body for fixture://resource/one");
	});

	it("stays absent when no server lists resources", async () => {
		const root = mcpRoot("res-none");
		setConfig(root, {});
		const pi = capturingPi();
		await attach(root, pi);
		expect(pi.registeredTools).not.toContain("mcp_list_resources");
	});

	it("maps binary contents to a guarded placeholder", async () => {
		const text = await readMcpResourceAsText(fakeBinaryServer(), "fake://bin");
		expect(text).toContain("[binary resource fake://bin (image/png)");
	});

	it("expands known mentions and passes malformed ones through with a notice", async () => {
		const root = mcpRoot("res-mention");
		setConfig(root, { fx: stdioServer(["--tools", "1"]) });
		const pi = capturingPi();
		await attach(root, pi);
		await awaitMcpToolRegistration("fx");
		const servers = () => getMcpService().getMcpResourceServers();

		const ok = await expandMcpResourceMentions("Use @mcp:fx/fixture://resource/one please", servers);
		expect(ok.changed).toBe(true);
		expect(ok.text).toContain("resource body for fixture://resource/one");
		expect(ok.text).toContain('<mcp-resource server="fx"');

		const bad = await expandMcpResourceMentions("See @mcp:nope/some://uri now", servers);
		expect(bad.changed).toBe(false);
		expect(bad.text).toBe("See @mcp:nope/some://uri now");
		expect(bad.notices).toHaveLength(1);
	});

	it("routes resource-updated notifications into the change callback", () => {
		const handlers: Array<() => void> = [];
		const client = { setNotificationHandler: (_schema: unknown, handler: () => void) => handlers.push(handler) };
		let changed = 0;
		subscribeMcpResourceUpdated(client as never, () => {
			changed += 1;
		});
		for (const handler of handlers) handler();
		expect(changed).toBe(1);
	});
});
