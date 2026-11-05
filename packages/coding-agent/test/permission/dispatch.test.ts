import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	authorizeToolDispatch,
	type DispatchPolicy,
	type DispatchRequest,
	prepareDispatchApproval,
	registerDispatchAuthorizer,
	transferDispatchApproval,
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
	const authorizer = { policy: () => policy, ask };
	const retire = registerDispatchAuthorizer(session, authorizer);
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
		authorizer,
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
	const rejected = expect(observed(pending)).rejects.toThrow("Permission authorizer was retired");
	await entered.promise;
	try {
		fx.retire();
		await rejected;
	} finally {
		reply.resolve();
		await pending.catch(() => undefined);
	}
});

it("does not revive old approval when the same callback object is registered again", async () => {
	const fx = fixture();
	const call = fx.request();
	const old = await fx.authorize(call);
	registerDispatchAuthorizer(fx.session, fx.authorizer);
	fx.retire();
	expect(old()).toBe(false);
	const current = await fx.authorize(call);
	const remoteWrite = vi.fn();
	if (current()) remoteWrite();
	expect(remoteWrite).toHaveBeenCalledOnce();
	expect(fx.ask).toHaveBeenCalledTimes(2);
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

async function observed<T>(event: Promise<T>): Promise<T> {
	const deadline = AbortSignal.timeout(2000);
	let onDeadline = () => {};
	const expired = new Promise<never>((_resolve, reject) => {
		onDeadline = () => reject(new Error("Dispatch event did not settle"));
		deadline.addEventListener("abort", onDeadline, { once: true });
	});
	try {
		return await Promise.race([event, expired]);
	} finally {
		deadline.removeEventListener("abort", onDeadline);
	}
}

// senpi#5795: the prepared executor executes a frozen copy of the preflight's arguments object.
describe("transferDispatchApproval", () => {
	const policy: DispatchPolicy = { action: "ask", fingerprint: "explicit-ask" };
	const approve = (fx: ReturnType<typeof fixture>, input: Record<string, unknown>) =>
		prepareDispatchApproval(fx.session, fx.request(input), policy)();

	it("moves an unchanged approval to the frozen copy and off the preflight object", async () => {
		const fx = fixture();
		const preflight = { value: "same" };
		approve(fx, preflight);
		const frozen = JSON.parse(JSON.stringify(preflight));
		transferDispatchApproval(preflight, frozen);
		await fx.authorize(fx.request(frozen));
		expect(fx.ask).not.toHaveBeenCalled();
		await fx.authorize(fx.request(preflight));
		expect(fx.ask).toHaveBeenCalledOnce();
	});

	it("does not move an approval whose input changed in place after it was given", async () => {
		const fx = fixture();
		const preflight: Record<string, unknown> = { value: "same" };
		approve(fx, preflight);
		preflight.value = "changed";
		const frozen = JSON.parse(JSON.stringify(preflight));
		transferDispatchApproval(preflight, frozen);
		await fx.authorize(fx.request(frozen));
		expect(fx.ask).toHaveBeenCalledOnce();
	});

	it("does not move an approval of a retired authorizer", async () => {
		const fx = fixture();
		const preflight = { value: "same" };
		approve(fx, preflight);
		fx.retire();
		const frozen = JSON.parse(JSON.stringify(preflight));
		transferDispatchApproval(preflight, frozen);
		registerDispatchAuthorizer(fx.session, fx.authorizer);
		await fx.authorize(fx.request(frozen));
		expect(fx.ask).toHaveBeenCalledOnce();
	});

	it("keeps the approval bound to its call: another toolCallId still asks", async () => {
		const fx = fixture();
		const preflight = { value: "same" };
		approve(fx, preflight);
		const frozen = JSON.parse(JSON.stringify(preflight));
		transferDispatchApproval(preflight, frozen);
		await fx.authorize({ ...fx.request(frozen), toolCallId: "another-id" });
		expect(fx.ask).toHaveBeenCalledOnce();
	});

	it("is a no-op without an approval or for non-object arguments", async () => {
		const fx = fixture();
		const frozen = { value: "same" };
		for (const [from, to] of [
			[{ value: "same" }, frozen],
			[null, frozen],
			["text", frozen],
			[frozen, null],
			[frozen, 7],
		] as const) {
			expect(() => transferDispatchApproval(from, to)).not.toThrow();
		}
		await fx.authorize(fx.request(frozen));
		expect(fx.ask).toHaveBeenCalledOnce();
	});
});
