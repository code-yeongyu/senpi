import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { buildMcpStatusRows, formatMcpStatus } from "../../src/core/extensions/builtin/mcp/status.ts";
import { ROTATED, SECRET } from "../suite/regressions/3858-reference-support.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

// #3858: actual requests must follow the new snapshot, including shared renewals.
it.each([false, true])("uses rotated header bytes on reconnect (shared=%s)", async (shared) => {
	const cleanup: Array<() => Promise<void>> = [];
	const fixture = await sharingHttpFixture();
	const registry = new HostMcpRegistry();
	const service = new McpService(shared ? { mcpRegistry: registry } : {});
	try {
		const root = makeRoot("3858-generation", cleanup);
		const path = join(root.agentDir, "key");
		writeFileSync(path, SECRET, { mode: 0o600 });
		setConfig(root, {
			fx: {
				type: "http",
				url: fixture.url,
				auth: false,
				headers: { Authorization: { $file: path } },
				exposure: "direct",
			},
		});
		const pi = capturingPi();
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir },
		);
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
		const firstHash = service.getServerSnapshots()[0]?.configHash;
		await Reflect.apply(registeredTool(pi, "mcp_fx_echo").execute, undefined, ["first", {}, undefined, undefined]);
		writeFileSync(path, ROTATED);
		await service.reconnectServer("fx");
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
		await Reflect.apply(registeredTool(pi, "mcp_fx_echo").execute, undefined, ["second", {}, undefined, undefined]);
		expect(fixture.callAuthorizations).toEqual([SECRET, ROTATED]);
		expect(service.getServerSnapshots()[0]?.configHash).not.toBe(firstHash);
	} finally {
		await service.dispose("quit");
		await registry.dispose();
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});

it.each(["file", "env"])(
	"reports a missing %s reference in status and RPC while another server works",
	async (kind) => {
		// #3858 QA (c): containment must also expose the named configuration failure.
		const cleanup: Array<() => Promise<void>> = [];
		const fixture = await sharingHttpFixture();
		const service = new McpService();
		try {
			const root = makeRoot("3858-independent", cleanup);
			const reference = kind === "file" ? { $file: join(root.agentDir, "missing") } : { $env: "UNSET_3858" };
			setConfig(root, {
				bad: { type: "http", url: fixture.url, headers: { Authorization: reference } },
				good: { type: "http", url: fixture.url, auth: false, exposure: "direct" },
			});
			const pi = capturingPi();
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				pi,
				{ agentDir: root.agentDir, env: {}, logDir: join(root.agentDir, "logs") },
			);
			expect(await service.whenAttachSettled(10_000)).toBe("settled");
			expect(pi.toolDefinitions.has("mcp_good_echo")).toBe(true);
			const message = `mcpServers.bad.headers.Authorization: configuration reference ${kind === "file" ? "missing" : "unset"}`;
			const snapshots = service.getServerSnapshots();
			expect.soft(snapshots.find((server) => server.name === "bad")).toMatchObject({
				lifecycleState: "degraded",
				lastError: message,
			});
			const status = formatMcpStatus(
				"MCP status",
				await buildMcpStatusRows(snapshots, (name) => service.getServerExposureStatus(name)),
			);
			expect.soft(status).toContain(`bad enabled state=degraded`);
			expect.soft(status).toContain(message);
			const wire = await service.refreshWireStatusSnapshot();
			expect.soft(wire.servers.find((server) => server.name === "bad")).toMatchObject({
				status: "degraded",
				lastError: message,
			});
			expect(service.getConnection("bad")).toBeUndefined();
			expect(JSON.parse(readFileSync(join(root.agentDir, "logs", "bad.log"), "utf8"))).toMatchObject({
				message: "ConfigReferenceError",
				data: {
					field: "mcpServers.bad.headers.Authorization",
					reference,
					reason: kind === "file" ? "missing" : "unset",
				},
			});
			await Reflect.apply(registeredTool(pi, "mcp_good_echo").execute, undefined, [
				"good",
				{},
				undefined,
				undefined,
			]);
			expect(fixture.calls).toBe(1);
			expect(fixture.connects).toBe(1);
		} finally {
			await service.dispose("quit");
			await fixture.close();
			await cleanupRoots(cleanup);
		}
	},
);
