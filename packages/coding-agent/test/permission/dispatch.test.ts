import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	authorizeToolDispatch,
	type DispatchPolicy,
	type DispatchRequest,
	prepareDispatchApproval,
	registerDispatchAuthorizer,
} from "../../src/core/extensions/builtin/permission-system/dispatch.ts";
import { createHarness } from "../suite/harness.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
beforeEach(async () => {
	harness = await createHarness({ extensionFactories: [] });
});
afterEach(() => harness.cleanup());

function fixture() {
	const session = harness.session.sessionManager;
	const ctx = harness.getExtensionRunner().createContext();
	let policy: DispatchPolicy = { action: "ask", fingerprint: "explicit-ask" };
	const ask = vi.fn(async () => {});
	const retire = registerDispatchAuthorizer(session, { policy: () => policy, ask });
	const owner = {};
	const request = (input: Record<string, unknown> = { value: "same" }): DispatchRequest => ({
		toolCallId: "provider-id",
		toolName: "mcp_fixture_write",
		input,
		identity: { owner, metadata: "original-operation" },
	});
	const authorize = (call: DispatchRequest, signal?: AbortSignal) => authorizeToolDispatch(session, call, ctx, signal);
	return {
		session,
		ctx,
		ask,
		retire,
		request,
		authorize,
		setPolicy: (next: DispatchPolicy) => {
			policy = next;
		},
	};
}

it("keeps one unchanged Once approval while the same invocation prepares again", async () => {
	const fx = fixture();
	const call = fx.request();
	const first = await fx.authorize(call);
	const second = await fx.authorize(call);
	const remoteWrite = vi.fn();
	if (first() && second()) remoteWrite();
	expect(remoteWrite).toHaveBeenCalledOnce();
	expect(fx.ask).toHaveBeenCalledOnce();
});

it("does not share Once approval between identical calls with the same provider ID", async () => {
	const fx = fixture();
	const first = fx.request();
	const second = fx.request();
	const fences = await Promise.all([fx.authorize(first), fx.authorize(second)]);
	const remoteWrite = vi.fn();
	for (const fence of fences) if (fence()) remoteWrite();
	expect(remoteWrite).toHaveBeenCalledTimes(2);
	expect(fx.ask).toHaveBeenCalledTimes(2);
});

it("refuses a newly denied operation after readiness without sending it", async () => {
	const fx = fixture();
	const call = fx.request();
	const fence = await fx.authorize(call);
	fx.setPolicy({ action: "deny", fingerprint: "new-deny" });
	const remoteWrite = vi.fn();
	if (fence()) remoteWrite();
	await expect(fx.authorize(call)).rejects.toMatchObject({ _tag: "PermissionDeniedError" });
	expect(remoteWrite).not.toHaveBeenCalled();
});

it("asks again when the operation or relevant Ask policy changes", async () => {
	const fx = fixture();
	const call = fx.request();
	const fence = await fx.authorize(call);
	fx.setPolicy({ action: "ask", fingerprint: "new-ask" });
	expect(fence()).toBe(false);
	await fx.authorize(call);
	const current = await fx.authorize({ ...call, identity: { owner: {}, metadata: call.identity.metadata } });
	const remoteWrite = vi.fn();
	if (current()) remoteWrite();
	expect(fx.ask).toHaveBeenCalledTimes(3);
	expect(remoteWrite).toHaveBeenCalledOnce();
});

it("does not approve metadata that changed while the approval was pending", async () => {
	const fx = fixture();
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	fx.ask.mockImplementation(async () => {
		entered.resolve();
		await reply.promise;
	});
	const call = fx.request();
	const pending = fx.authorize(call);
	await entered.promise;
	call.input.value = "different-operation";
	reply.resolve();
	const fence = await pending;
	const remoteWrite = vi.fn();
	if (fence()) remoteWrite();
	expect(remoteWrite).not.toHaveBeenCalled();
	await fx.authorize(call);
	expect(fx.ask).toHaveBeenCalledTimes(2);
});

it("rejects pending approval when its authorizer is retired", async () => {
	const fx = fixture();
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	fx.ask.mockImplementation(async () => {
		entered.resolve();
		await reply.promise;
	});
	const pending = fx.authorize(fx.request());
	const rejected = expect(pending).rejects.toThrow("Permission authorizer was retired");
	await entered.promise;
	fx.retire();
	reply.resolve();
	await rejected;
});

it("does not let cleanup of the old registration retire its replacement", async () => {
	const fx = fixture();
	const old = await fx.authorize(fx.request());
	const ask = vi.fn(async () => {});
	registerDispatchAuthorizer(fx.session, { policy: () => ({ action: "allow", fingerprint: "allow" }), ask });
	fx.retire();
	expect(old()).toBe(false);
	const current = await fx.authorize(fx.request());
	const remoteWrite = vi.fn();
	if (current()) remoteWrite();
	expect(remoteWrite).toHaveBeenCalledOnce();
	expect(ask).not.toHaveBeenCalled();
});

it("aborts only the selected approval waiter", async () => {
	const fx = fixture();
	const entered = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	fx.ask.mockImplementationOnce(async () => {
		entered.resolve();
		await reply.promise;
	});
	const abort = new AbortController();
	const pending = fx.authorize(fx.request(), abort.signal);
	const rejected = expect(pending).rejects.toThrow("cancel selected call");
	await entered.promise;
	abort.abort(new Error("cancel selected call"));
	await rejected;
	const current = await fx.authorize(fx.request());
	const remoteWrite = vi.fn();
	if (current()) remoteWrite();
	expect(remoteWrite).toHaveBeenCalledOnce();
	reply.resolve();
});

it("keeps each model-issued call's preflight approval on its own validated input", async () => {
	const ask = vi.fn(async () => {});
	const remoteWrite = vi.fn();
	const owner = {};
	const identity = { owner, metadata: "operation" };
	const policy: DispatchPolicy = { action: "ask", fingerprint: "ask" };
	let prompts = 0;
	const real = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					registerDispatchAuthorizer(ctx.sessionManager, { policy: () => policy, ask });
				});
				pi.on("tool_call", (event, ctx) => {
					const approve = prepareDispatchApproval(
						ctx.sessionManager,
						{ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, identity },
						policy,
					);
					prompts++;
					approve();
				});
				pi.registerTool({
					name: "mcp_fixture_write",
					label: "Fixture write",
					description: "Write to the fixture",
					parameters: Type.Object({ value: Type.String() }),
					async execute(toolCallId, input, signal, _onUpdate, ctx) {
						const fence = await authorizeToolDispatch(
							ctx.sessionManager,
							{ toolCallId, toolName: "mcp_fixture_write", input, identity },
							ctx,
							signal,
						);
						if (fence()) remoteWrite(input.value);
						return { content: [{ type: "text", text: "written" }], details: {} };
					},
				});
			},
		],
	});
	try {
		real.setResponses([
			() => ({
				...fauxAssistantMessage(""),
				stopReason: "toolUse",
				content: ["first", "second"].map((id) => ({
					type: "toolCall",
					id,
					name: "mcp_fixture_write",
					arguments: { value: "same" },
				})),
			}),
			() => fauxAssistantMessage("done"),
		]);
		await real.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
		await real.session.prompt("write twice");
		expect(remoteWrite).toHaveBeenCalledTimes(2);
		expect(prompts).toBe(2);
		expect(ask).not.toHaveBeenCalled();
	} finally {
		real.cleanup();
	}
});
