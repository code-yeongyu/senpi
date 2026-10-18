import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { AssistantEditError, SessionStreamingError } from "../../src/core/edited-assistant-message.ts";
import { UserEditError, type UserEditReason } from "../../src/core/edited-user-message.ts";
import type { ExtensionCommandContext } from "../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { RpcClient, RpcCommandError } from "../../src/modes/rpc/rpc-client.ts";
import type { RpcCommand, RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { makeSink } from "./rpc-connection-harness.ts";

const harnesses: Harness[] = [];
const handlers: RpcConnectionHandler[] = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const handler of handlers.splice(0)) await handler.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

type Mode = "rpc" | "print" | "interactive";

async function fixture(mode: Mode, metadata = false) {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				if (metadata)
					pi.on("session_tree", () => {
						pi.appendEntry("edit-test-metadata", {});
					});
			},
		],
	});
	harnesses.push(harness);
	const runtime = {
		session: harness.session,
		setRebindSession: vi.fn(),
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	const ui = {
		session: harness.session,
		createExtensionUIContext: () => undefined,
		chatContainer: { clear: vi.fn() },
		editor: { getText: () => "", setText: vi.fn() },
		renderInitialMessages: vi.fn(),
		showStatus: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
		setupAutocompleteProvider: vi.fn(),
		setupExtensionShortcuts: vi.fn(),
		showLoadedResources: vi.fn(),
		showStartupNoticesIfNeeded: vi.fn(),
	};
	let client: RpcClient | undefined;
	if (mode === "rpc") {
		const sink = makeSink();
		const handler = createRpcConnectionHandler(runtime, sink.sink);
		handlers.push(handler);
		await handler.ready;
		client = new RpcClient();
		let sequence = 0;
		// Only replace the transport; the real client decoder and host dispatcher remain in the path.
		(client as unknown as { send(command: Omit<RpcCommand, "id">): Promise<RpcResponse> }).send = async (command) => {
			const id = `extension-edit-${++sequence}`;
			const response = sink.waitFor((record) => record.type === "response" && record.id === id);
			await handler.handleInputLine(JSON.stringify({ ...command, id }));
			return (await response) as RpcResponse;
		};
	} else if (mode === "print") {
		expect(await runPrintMode(runtime, { mode: "text" })).toBe(0);
	} else {
		const bind = Reflect.get(InteractiveMode.prototype, "bindCurrentSessionExtensions") as (
			this: typeof ui,
		) => Promise<void>;
		await bind.call(ui);
	}
	const manager = harness.sessionManager;
	manager.resetLeaf();
	const root = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const assistant = manager.appendMessage(fauxAssistantMessage("one"));
	const user = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
	const leaf = manager.appendMessage(fauxAssistantMessage("two"));
	harness.agent.state.messages = manager.buildSessionContext().messages;
	return {
		harness,
		manager,
		root,
		assistant,
		user,
		leaf,
		ui,
		client,
		ctx: harness.getExtensionRunner().createCommandContext(),
	};
}

describe.each<Mode>(["rpc", "print", "interactive"])("%s extension context", (mode) => {
	it("binds editUserMessage to core with intact arguments and keeps entry identity separate from metadata leaf", async () => {
		const { harness, manager, ctx, user, assistant, leaf, ui } = await fixture(mode, true);
		const edit = vi.spyOn(harness.session, "editUserMessage");
		const options = { expectedLeafId: leaf, summarize: false, customInstructions: "retain decisions" };
		const result = await ctx.editUserMessage(user, "  revised second  ", options);
		expect(edit).toHaveBeenCalledExactlyOnceWith(user, "  revised second  ", options);
		expect(result.cancelled).toBe(false);
		const entry = manager.getEntry(result.entryId!);
		expect(entry).toMatchObject({ type: "message", parentId: assistant, message: { role: "user" } });
		if (entry?.type !== "message") throw new Error("expected edited message");
		expect(getMessageText(entry.message)).toBe("revised second");
		expect(manager.getEntry(manager.getLeafId()!)).toMatchObject({ type: "custom", parentId: entry.id });
		expect(manager.getLeafId()).not.toBe(entry.id);
		expect(manager.getEntry(user)).toBeDefined();
		if (mode === "interactive") expect(ui.renderInitialMessages).toHaveBeenCalledOnce();
		await ctx.navigateTree({ entryId: entry.id, expectedLeafId: manager.getLeafId()!, summarize: false });
		expect(manager.getEntry(manager.getLeafId()!)).toMatchObject({ type: "custom", parentId: assistant });
	});

	it.each<UserEditReason>(["not-found", "not-user", "empty", "stale-leaf"])(
		"preserves the core %s rejection object",
		async (reason) => {
			const { harness, ctx, user, assistant, leaf } = await fixture(mode);
			const original = harness.session.editUserMessage.bind(harness.session);
			let coreError: unknown;
			vi.spyOn(harness.session, "editUserMessage").mockImplementation(async (...args) => {
				try {
					return await original(...args);
				} catch (error) {
					coreError = error;
					throw error;
				}
			});
			const failure = await ctx
				.editUserMessage(
					reason === "not-found" ? "missing" : reason === "not-user" ? assistant : user,
					reason === "empty" ? "  " : "revised",
					{ expectedLeafId: reason === "stale-leaf" ? "old-token" : leaf, summarize: false },
				)
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(UserEditError);
			expect(failure).toBe(coreError);
			expect(failure).toMatchObject({ reason, code: reason.replaceAll("-", "_") });
		},
	);

	it.each(["old-token", "", undefined])(
		"forwards edit token %j without defaulting or refreshing it",
		async (expectedLeafId) => {
			const { harness, ctx, user } = await fixture(mode);
			const edit = vi.spyOn(harness.session, "editUserMessage");
			const result = ctx.editUserMessage(user, "revised", { expectedLeafId, summarize: false });
			if (expectedLeafId === undefined) await expect(result).resolves.toMatchObject({ cancelled: false });
			else await expect(result).rejects.toMatchObject({ code: "stale_leaf" });
			expect(edit).toHaveBeenCalledExactlyOnceWith(user, "revised", {
				expectedLeafId,
				summarize: false,
				customInstructions: undefined,
			});
		},
	);

	it("preserves the streaming refusal unchanged", async () => {
		const { harness, ctx, user } = await fixture(mode);
		const error = new SessionStreamingError();
		vi.spyOn(harness.session, "editUserMessage").mockRejectedValueOnce(error);
		await expect(ctx.editUserMessage(user, "revised")).rejects.toBe(error);
	});

	it("preserves unchanged and cancelled results without refreshing the TUI", async () => {
		const { harness, ctx, user, ui } = await fixture(mode);
		await expect(ctx.editUserMessage(user, "second")).resolves.toMatchObject({ cancelled: false, unchanged: true });
		vi.spyOn(harness.session, "editUserMessage").mockResolvedValueOnce({ cancelled: true });
		await expect(ctx.editUserMessage(user, "revised")).resolves.toMatchObject({ cancelled: true });
		expect(ui.renderInitialMessages).not.toHaveBeenCalled();
	});

	it("keeps positional navigation and accepts entryId addressing with verbatim concurrency tokens", async () => {
		const { harness, manager, ctx, root, user, assistant, leaf } = await fixture(mode);
		const navigate = vi.spyOn(harness.session, "navigateTree");
		await ctx.navigateTree(user);
		expect(navigate).toHaveBeenLastCalledWith(user, expect.objectContaining({ expectedLeafId: undefined }));
		expect(manager.getLeafId()).toBe(assistant);
		const options = {
			expectedLeafId: leaf,
			summarize: false,
			customInstructions: "keep context",
			replaceInstructions: true,
			label: "checkpoint",
		};
		// The caller's old token must not be refreshed/defaulted to the now-current leaf.
		await expect(ctx.navigateTree({ entryId: root, ...options })).rejects.toMatchObject({ code: "stale_leaf" });
		expect(navigate).toHaveBeenLastCalledWith(root, options);
		await expect(ctx.navigateTree(root, { expectedLeafId: "" })).rejects.toBeInstanceOf(AssistantEditError);
		expect(navigate).toHaveBeenLastCalledWith(root, expect.objectContaining({ expectedLeafId: "" }));
		await ctx.navigateTree({ entryId: root, expectedLeafId: assistant });
		expect(manager.getLeafId()).toBeNull();
	});
});

it("keeps user-edit options identical to assistant-edit options", () => {
	expectTypeOf<Parameters<ExtensionCommandContext["editUserMessage"]>[2]>().toEqualTypeOf<
		Parameters<ExtensionCommandContext["editAssistantMessage"]>[2]
	>();
});

describe("RpcClient user edits and navigation", () => {
	// #1926: the typed client must not discard exact-leaf intent before the real handler sees it.
	it.each([false, true])(
		"resumes an exact user leaf through client/handler with lifecycle metadata %j",
		async (metadata) => {
			const { client, harness, manager, user, leaf } = await fixture("rpc", metadata);
			const call = vi.spyOn(harness.session, "navigateTree");
			const result = await client!.navigateTree(user, { intent: "resume", expectedLeafId: leaf });
			expect(result).toEqual({ cancelled: false, leafId: user });
			expect(call).toHaveBeenCalledWith(user, expect.objectContaining({ intent: "resume", expectedLeafId: leaf }));
			expect(manager.getLeafId()).toBe(user);
			expect(harness.session.messages.map(getMessageText)).toEqual(["first", "one", "second"]);
			if (metadata) {
				const appended = manager.getEntries().at(-1)!;
				expect(appended).toMatchObject({ type: "custom", parentId: user, customType: "edit-test-metadata" });
				expect(manager.getBranch()).not.toContainEqual(appended);
			}
		},
	);

	it("exposes the host leafId as a nullable typed field on a client navigation call", async () => {
		const { client, root } = await fixture("rpc");
		const result = await client!.navigateTree(root);
		expectTypeOf(result.leafId).toEqualTypeOf<string | null>();
		expect(result.leafId).toBeNull();
	});

	it("forwards navigation expectedLeafId rather than silently dropping a stale token", async () => {
		const { client, root } = await fixture("rpc");
		await expect(client!.navigateTree(root, { expectedLeafId: "old-token" })).rejects.toMatchObject({
			errorCode: "stale_leaf",
		});
	});

	it("decodes user edits with a different entry id and leaf and preserves typed wire refusals", async () => {
		const { client, harness, user, leaf } = await fixture("rpc", true);
		const call = vi.spyOn(harness.session, "editUserMessage");
		const result = await client!.editUserMessage(user, "revised", {
			expectedLeafId: leaf,
			summarize: false,
			customInstructions: "retain decisions",
		});
		expect(call).toHaveBeenCalledExactlyOnceWith(user, "revised", {
			expectedLeafId: leaf,
			summarize: false,
			customInstructions: "retain decisions",
		});
		expect(result.outcome).toBe("edited");
		if (result.outcome !== "edited") throw new Error("expected edit");
		expect(result.entry.id).not.toBe(result.leafId);
		await expect(client!.editUserMessage(user, "again", { expectedLeafId: leaf })).rejects.toBeInstanceOf(
			RpcCommandError,
		);
	});
});
