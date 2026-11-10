import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { SharedMcpLease } from "../../../src/core/extensions/builtin/mcp/shared-lease.ts";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { textContent } from "../../mcp/fixtures/register-call.ts";
import { createHarness, createTestUiContext, getToolResult } from "../harness.ts";
import { oauthHarness } from "./2861-mcp-oauth-support.ts";

// #2861: the offered definition belongs to a real service, including its credential reconciliation callback.
for (const shared of [false, true]) {
	for (const lifecycle of ["lazy", "keep-alive"] as const) {
		it(`keeps an offered ${shared ? "shared" : "private"} ${lifecycle} call through same-grant rotation`, async () => {
			const harness = await oauthHarness(shared, lifecycle);
			try {
				await harness.signIn();
				const first = await harness.attach();
				const peer = shared ? await harness.attach() : undefined;
				const owner = first.service.getConnection("race");
				const peerOwner = peer?.service.getConnection("race");
				if (peerOwner instanceof SharedMcpLease && owner instanceof SharedMcpLease) {
					expect(peerOwner.shared).toBe(owner.shared);
				}
				expect(textContent(await first.call("before"))).toBe("fixture tool_1 value=before mode=alpha");
				const original = harness.store.read();
				const before = await harness.fixture.getLog();
				await harness.expire();
				// Observe the result after checking that the intended refresh, rather than an unrelated failure, happened.
				const result = await first.call("after").then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				);
				const after = await harness.fixture.getLog();
				expect(after.tokenHits - before.tokenHits).toBe(1);
				expect(harness.store.read()?.accessToken).not.toBe(original?.accessToken);
				expect(harness.store.read()?.refreshToken).not.toBe(original?.refreshToken);
				expect(after.familyInvalidated).toBe(false);
				if ("error" in result) throw result.error;
				expect(textContent(result.value)).toBe("fixture tool_1 value=after mode=alpha");
				expect(first.service.getConnection("race")).toBe(owner);
				expect(after.requests.filter((request) => request.rpcMethod === "tools/call")).toHaveLength(2);
				if (peer !== undefined) {
					expect(textContent(await peer.call("peer"))).toBe("fixture tool_1 value=peer mode=alpha");
					expect(peer.service.getConnection("race")).toBe(peerOwner);
					const newcomer = await harness.attach();
					const joined = newcomer.service.getConnection("race");
					expect(joined).toBeInstanceOf(SharedMcpLease);
					if (joined instanceof SharedMcpLease && owner instanceof SharedMcpLease) {
						expect(joined.shared).toBe(owner.shared);
					}
				}
			} finally {
				await harness.cleanup();
			}
		});
	}
}

it("keeps a retained offer after another process performs two unobserved rotations", async () => {
	const harness = await oauthHarness(false, "lazy");
	try {
		harness.config.oauth = { scopes: ["mcp", "offline_access"], clientId: "race-client" };
		await writeFile(join(harness.dir, "mcp.json"), JSON.stringify({ mcpServers: { race: harness.config } }));
		await harness.signIn();
		const owner = await harness.attach();
		const connection = owner.service.getConnection("race");
		const before = await harness.fixture.getLog();
		for (let rotation = 0; rotation < 2; rotation++) {
			await harness.expire();
			await new Promise<void>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[
						join(import.meta.dirname, "../../mcp/fixtures/oauth-race-worker.ts"),
						harness.dir,
						harness.fixture.mcpUrl,
						"-",
						`rotation-${rotation}`,
						"0",
					],
					{ env: process.env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
				);
				let stdout = "";
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				child.on("error", reject);
				child.on("exit", (code) => {
					if (code === 0 && stdout.includes('"ok":true')) resolve();
					else reject(new Error(`refresh worker failed with exit ${code}`));
				});
			});
		}
		const afterRotations = await harness.fixture.getLog();
		expect(afterRotations.tokenHits - before.tokenHits).toBe(2);
		expect(textContent(await owner.call("missed"))).toBe("fixture tool_1 value=missed mode=alpha");
		expect(owner.service.getConnection("race")).toBe(connection);
		const afterCall = await harness.fixture.getLog();
		expect(afterCall.tokenHits).toBe(afterRotations.tokenHits);
		expect(afterCall.familyInvalidated).toBe(false);
		expect(afterCall.requests.filter((request) => request.rpcMethod === "tools/call")).toHaveLength(1);
	} finally {
		await harness.cleanup();
	}
});

// #2861: real Once consent belongs to the unchanged grant and operation; it cannot transfer to a new sign-in.
for (const replacement of [false, true]) {
	it(
		replacement
			? "requires fresh Once approval after authorization replacement"
			: "keeps Once approval through same-grant refresh",
		async () => {
			const oauth = await oauthHarness(false, "lazy");
			const service = new McpService();
			const previous = process.env[ENV_AGENT_DIR];
			let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
			try {
				await oauth.signIn();
				process.env[ENV_AGENT_DIR] = oauth.dir;
				let approvals = 0;
				harness = await createHarness({
					extensionFlagValues: new Map([["permission-preset", "ask"]]),
					extensionFactories: [permissionSystemExtension, createMcpExtension(service)],
				});
				await harness.session.bindExtensions({
					uiContext: createTestUiContext({
						select: async () => {
							approvals++;
							if (approvals === 1) {
								if (replacement) await oauth.signIn();
								else await oauth.expire();
							}
							return "Allow once";
						},
					}),
				});
				await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
				expect(await service.whenAttachSettled(5000)).toBe("settled");
				const name = "mcp_race_tool_1";
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall(name, { value: "permission" }), { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt("call the fixture");
				expect(approvals).toBe(1);
				const log = await oauth.fixture.getLog();
				expect(log.requests.filter((request) => request.rpcMethod === "tools/call")).toHaveLength(
					replacement ? 0 : 1,
				);
				if (replacement) {
					expect(getToolResult(harness, name)).toHaveProperty("details.error.kind", "unavailable");
					expect(await service.whenAttachSettled(5000)).toBe("settled");
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall(name, { value: "new-grant" }), { stopReason: "toolUse" }),
						fauxAssistantMessage("done"),
					]);
					await harness.session.prompt("explicitly call the new offer");
					expect(getToolResult(harness, name).content).toEqual([
						{ type: "text", text: "fixture tool_1 value=new-grant mode=alpha" },
					]);
					expect(approvals).toBe(2);
					expect(
						(await oauth.fixture.getLog()).requests.filter((request) => request.rpcMethod === "tools/call"),
					).toHaveLength(1);
				} else {
					expect(getToolResult(harness, name).content).toEqual([
						{ type: "text", text: "fixture tool_1 value=permission mode=alpha" },
					]);
					expect(log.requests.filter((request) => request.grantType === "refresh_token")).toHaveLength(1);
				}
			} finally {
				await service.dispose("quit");
				harness?.cleanup();
				if (previous === undefined) delete process.env[ENV_AGENT_DIR];
				else process.env[ENV_AGENT_DIR] = previous;
				await oauth.cleanup();
			}
		},
	);
}
