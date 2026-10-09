import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { authorizeToolDispatch } from "../../src/core/extensions/builtin/permission-system/dispatch.ts";
import { registerDispatchIdentity } from "../../src/core/extensions/builtin/permission-system/dispatch-metadata.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, getToolResult } from "../suite/harness.ts";

async function fixture(
	preset: string,
	select: (prompt: number) => Promise<string | undefined> = async () => "Allow once",
) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const remoteWrite = vi.fn();
	const identity = { owner: {}, metadata: "offered-operation" };
	const parameters = Type.Object({ value: Type.String() });
	registerDispatchIdentity(parameters, () => ({ ...identity }));
	let prompts = 0;
	const harness = await createHarness({
		extensionFlagValues: new Map([["permission-preset", preset]]),
		extensionFactories: [
			permissionSystemExtension,
			(pi) => {
				pi.registerTool({
					name: "mcp_fixture_write",
					label: "Fixture write",
					description: "Write through the fixture's prepared MCP operation",
					parameters,
					async execute(toolCallId, input, signal, _onUpdate, ctx) {
						entered.resolve();
						await release.promise;
						const request = { toolCallId, toolName: "mcp_fixture_write", input, identity: { ...identity } };
						for (;;) {
							const current = await authorizeToolDispatch(ctx.sessionManager, request, ctx, signal);
							if (!current()) continue;
							remoteWrite(input.value);
							break;
						}
						return { content: [{ type: "text", text: "written" }], details: {} };
					},
				});
			},
		],
	});
	try {
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async () => select(++prompts),
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp_fixture_write", { value: "payload" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		return { harness, entered, release, remoteWrite, identity, prompts: () => prompts };
	} catch (error) {
		harness.cleanup();
		throw error;
	}
}

it("retains an unchanged Once approval after real permission preflight and readiness", async () => {
	const fx = await fixture("ask");
	const prompt = fx.harness.session.prompt("write");
	try {
		await fx.entered.promise;
		fx.release.resolve();
		await prompt;
		expect(fx.prompts()).toBe(1);
		expect(fx.remoteWrite).toHaveBeenCalledOnce();
	} finally {
		fx.release.resolve();
		await prompt;
		fx.harness.cleanup();
	}
});

it("uses a stricter live preset after readiness instead of an earlier Allow", async () => {
	const fx = await fixture("full-access", async () => "Deny");
	const prompt = fx.harness.session.prompt("write");
	try {
		await fx.entered.promise;
		fx.harness.getExtensionRunner().setFlagValue("permission-preset", "ask");
		fx.release.resolve();
		await prompt;
		expect(fx.prompts()).toBe(1);
		expect(fx.remoteWrite).not.toHaveBeenCalled();
		expect(getToolResult(fx.harness, "mcp_fixture_write").isError).toBe(true);
	} finally {
		fx.release.resolve();
		await prompt;
		fx.harness.cleanup();
	}
});

it("observes a new explicit Deny even when the preset itself has not changed", async () => {
	const fx = await fixture("full-access");
	const prompt = fx.harness.session.prompt("write");
	try {
		await fx.entered.promise;
		fx.harness.getExtensionRunner().setFlagValue("permission", "mcp_fixture_write=deny");
		fx.release.resolve();
		await prompt;
		expect(fx.prompts()).toBe(0);
		expect(fx.remoteWrite).not.toHaveBeenCalled();
		expect(getToolResult(fx.harness, "mcp_fixture_write").isError).toBe(true);
	} finally {
		fx.release.resolve();
		await prompt;
		fx.harness.cleanup();
	}
});

it("asks again for changed operation metadata rather than extending Once consent", async () => {
	const fx = await fixture("ask");
	const prompt = fx.harness.session.prompt("write");
	try {
		await fx.entered.promise;
		fx.identity.metadata = "changed-operation";
		fx.release.resolve();
		await prompt;
		expect(fx.prompts()).toBe(2);
		expect(fx.remoteWrite).toHaveBeenCalledOnce();
	} finally {
		fx.release.resolve();
		await prompt;
		fx.harness.cleanup();
	}
});

it("rechecks a Deny installed while the replacement approval is pending", async () => {
	const approvalEntered = Promise.withResolvers<void>();
	const approvalReply = Promise.withResolvers<string>();
	const fx = await fixture("ask", async (prompt) => {
		if (prompt === 1) return "Allow once";
		approvalEntered.resolve();
		return approvalReply.promise;
	});
	const prompt = fx.harness.session.prompt("write");
	try {
		await fx.entered.promise;
		fx.identity.metadata = "changed-operation";
		fx.release.resolve();
		await approvalEntered.promise;
		fx.harness.getExtensionRunner().setFlagValue("permission", "mcp_fixture_write=deny");
		approvalReply.resolve("Allow once");
		await prompt;
		expect(fx.prompts()).toBe(2);
		expect(fx.remoteWrite).not.toHaveBeenCalled();
		expect(getToolResult(fx.harness, "mcp_fixture_write").isError).toBe(true);
	} finally {
		fx.release.resolve();
		approvalReply.resolve("Deny");
		await prompt;
		fx.harness.cleanup();
	}
});

it("refuses an operation whose permission extension shut down during readiness", async () => {
	const fx = await fixture("full-access");
	const prompt = fx.harness.session.prompt("write");
	try {
		await fx.entered.promise;
		await fx.harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "reload" });
		fx.release.resolve();
		await prompt;
		expect(fx.remoteWrite).not.toHaveBeenCalled();
		expect(getToolResult(fx.harness, "mcp_fixture_write").isError).toBe(true);
	} finally {
		fx.release.resolve();
		await prompt;
		fx.harness.cleanup();
	}
});
