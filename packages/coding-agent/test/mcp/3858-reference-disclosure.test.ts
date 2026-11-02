import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpCatalogCache, writeMcpCachedServer } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { diagnoseCapturedMcpConnectFailure } from "../../src/core/extensions/builtin/mcp/diagnose.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	ensureMcpResourceSubscriptions,
	expandMcpResourceMentions,
} from "../../src/core/extensions/builtin/mcp/resources.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { buildMcpServerSnapshot } from "../../src/core/extensions/builtin/mcp/service-snapshot.ts";
import { ROTATED, referenceRoot, resolveReference, SECRET } from "../suite/regressions/3858-reference-support.ts";
import { serverConfig } from "./fixtures/reconnect.ts";
import { capturingPi, registeredTool, textContent } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer } from "./fixtures/service-lifecycle.ts";
import { spawnHttpFixture } from "./fixtures/spawn-fixture.ts";

// #3858: redaction is an outbound projection, never a mutation of protocol data.
describe("reference disclosure boundaries", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		files = referenceRoot();
	});
	afterEach(() => files.close());

	async function resolve(value = SECRET) {
		await resolveReference({ $env: "VALUE" }, { root: files.root, env: { VALUE: value } });
	}

	it("redacts raw, URL encoded and nested cause values from logs after rotation", async () => {
		await resolve();
		await resolve(ROTATED);
		const logger = createMcpLogger("fixture", { logDir: files.root });
		logger.info(`${SECRET} ${encodeURIComponent(SECRET)}`, new Error(ROTATED, { cause: new Error(SECRET) }));
		const output = logger.getRingBuffer().join("\n") + readFileSync(logger.filePath, "utf8");
		for (const value of [SECRET, ROTATED, encodeURIComponent(SECRET)]) expect(output).not.toContain(value);
		expect(output).toContain("redacted");
	});

	it("retains all 257 active values and an old value after later rotations", async () => {
		const values = Array.from({ length: 258 }, (_, index) => `synthetic-3858-entry-${index}-end`);
		for (const value of values) await resolve(value);
		const logger = createMcpLogger("retired", { logDir: files.root });
		logger.info(values.join(" "));
		const output = logger.getRingBuffer().join("\n");
		for (const value of values) expect(output).not.toContain(value);
	});

	it("keeps subscription identifiers raw while persisting a separate redacted catalog", async () => {
		await resolve();
		const uri = `fixture://${SECRET}`;
		const resources = [{ name: "resource", uri }];
		const subscribed: string[] = [];
		await Reflect.apply(ensureMcpResourceSubscriptions, undefined, [
			{
				getServerCapabilities: () => ({ resources: { subscribe: true } }),
				subscribeResource: async ({ uri: target }: { uri: string }) => {
					subscribed.push(target);
					return {};
				},
			},
			resources,
		]);
		await writeMcpCachedServer(files.root, "fixture", {
			configHash: "synthetic-hmac",
			credentialIdentity: "none",
			fetchedAt: Date.now(),
			tools: [],
			prompts: [],
			resources,
		});
		expect(subscribed).toEqual([uri]);
		expect(resources[0]?.uri).toBe(uri);
		expect(JSON.stringify(await readMcpCatalogCache(files.root))).not.toContain(SECRET);
	});

	it("sanitizes snapshot and diagnostic errors without changing the original error", async () => {
		await resolve();
		const error = new Error(`reflected ${SECRET}`, { cause: new Error(encodeURIComponent(SECRET)) });
		const snapshot = Reflect.apply(buildMcpServerSnapshot, undefined, [
			"fixture",
			undefined,
			{ state: "degraded", generation: 1, getRootPid: () => null, lastError: error },
			undefined,
		]);
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
		const logger = createMcpLogger("diagnostic", { logDir: files.root });
		logger.stderr(SECRET);
		const diagnostic = diagnoseCapturedMcpConnectFailure({
			config: serverConfig(),
			cause: error,
			logger,
			serverName: "fixture",
		});
		expect(diagnostic?.message).not.toContain(SECRET);
		expect(error.message).toContain(SECRET);
	});

	it("redacts needs_auth errors in real service snapshots and RPC inventory snapshots", async () => {
		await resolve();
		const cleanup: Array<() => Promise<void>> = [];
		const service = new McpService();
		try {
			const root = makeRoot("3858-needs-auth", cleanup);
			const fixture = await spawnHttpFixture(["--tools", "1"]);
			cleanup.push(fixture.cleanup);
			setConfig(root, {
				fx: { type: "http", url: fixture.url, auth: "oauth", exposure: "direct" },
			});
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				capturingPi(),
				{ agentDir: root.agentDir },
			);
			expect(await service.whenAttachSettled(10_000)).toBe("settled");
			const connection = service.getConnection("fx");
			if (connection === undefined) throw new Error("fixture did not connect");
			const error = new Error(`authenticate ${SECRET}`);
			connection.markNeedsAuth(error);

			expect(service.getServerSnapshots()).toMatchObject([
				{ lifecycleState: "needs_auth", lastError: "authenticate <redacted>" },
			]);
			expect((await service.refreshWireStatusSnapshot()).servers).toMatchObject([
				{ status: "needs_auth", lastError: "authenticate <redacted>" },
			]);
			expect(error.message).toBe(`authenticate ${SECRET}`);
		} finally {
			await service.dispose("quit");
			await cleanupRoots(cleanup);
		}
	});

	it("sanitizes server tool and resource text before model, display and spill sinks", async () => {
		// #3858 QA (a): a real server reflects a resolved value; wire replies must stay raw.
		const cleanup: Array<() => Promise<void>> = [];
		const service = new McpService();
		const secret = "synthetic/3858?+output";
		try {
			const root = makeRoot("3858-reflected-output", cleanup);
			setConfig(root, {
				fx: { ...stdioServer(["--tools", "1"]), env: { TOKEN: { $env: "VALUE" } }, exposure: "direct" },
			});
			const pi = capturingPi();
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				pi,
				{ agentDir: root.agentDir, env: { VALUE: secret } },
			);
			expect(await service.whenAttachSettled(10_000)).toBe("settled");
			const client = service.getConnection("fx")?.client;
			if (client === undefined) throw new Error("fixture did not connect");
			const reflected = secret;
			const uri = `fixture://${encodeURIComponent(secret)}`;

			const rawTool = await client.callTool({ name: "tool_1", arguments: { value: reflected } });
			const rawResource = await client.readResource({ uri });
			const result = await Reflect.apply(registeredTool(pi, "mcp_fx_tool_1").execute, undefined, [
				"echo",
				{ value: reflected },
				undefined,
				undefined,
			]);
			const resource = await Reflect.apply(registeredTool(pi, "mcp_read_resource").execute, undefined, [
				"read",
				{ server: "fx", uri },
				undefined,
				undefined,
			]);
			const mention = await expandMcpResourceMentions(`Read @mcp:fx/${uri}`, () => service.getMcpResourceServers());
			const spill = await Reflect.apply(registeredTool(pi, "mcp_fx_tool_1").execute, undefined, [
				"spill",
				{ value: reflected.repeat(8000) },
				undefined,
				undefined,
			]);
			const spillPath = /Full output saved to: (.+)/.exec(textContent(spill))?.[1];
			if (spillPath === undefined) throw new Error("fixture did not spill");
			const outward = JSON.stringify({ result, resource, mention }) + readFileSync(spillPath, "utf8");

			expect(JSON.stringify(rawTool)).toContain(secret);
			expect(JSON.stringify(rawResource)).toContain(encodeURIComponent(secret));
			expect.soft(outward).not.toContain(secret);
			expect.soft(outward).not.toContain(encodeURIComponent(secret));
			expect.soft(outward).toContain("<redacted>");
		} finally {
			await service.dispose("quit");
			await cleanupRoots(cleanup);
		}
	});
});
