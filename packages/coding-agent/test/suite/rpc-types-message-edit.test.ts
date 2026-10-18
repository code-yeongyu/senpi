import { describe, expect, it } from "vitest";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import type {
	EditUserMessageResult,
	NavigateTreeResult,
	RpcCommand,
	RpcErrorCode,
	RpcResponse,
} from "../../src/modes/rpc/rpc-types.ts";
import { RPC_ERROR_NOT_ASSISTANT, RPC_ERROR_NOT_USER } from "../../src/modes/rpc/rpc-types.ts";

const editUserMessageCommand = {
	id: "req-1",
	type: "edit_user_message",
	entryId: "u1",
	text: "the corrected prompt",
	expectedLeafId: "leaf-1",
	summarize: true,
	customInstructions: "one line",
} satisfies RpcCommand;

const navigateTreeCommand = {
	id: "req-2",
	type: "navigate_tree",
	entryId: "u1",
	expectedLeafId: "leaf-1",
	summarize: true,
	customInstructions: "one line",
	label: "before the rewrite",
} satisfies RpcCommand;

/** The shipped spelling `navigate_tree` has always used; adding `entryId` must not retire it. */
const legacyNavigateTreeCommand = {
	type: "navigate_tree",
	targetId: "a9",
	summarize: false,
	replaceInstructions: false,
} satisfies RpcCommand;

/** `expectedLeafId` guards BOTH spellings: a navigation is as destructive to a stale window as an edit. */
const guardedLegacyNavigateTreeCommand = {
	type: "navigate_tree",
	targetId: "a9",
	expectedLeafId: "leaf-1",
} satisfies RpcCommand;

const editedEntry: SessionMessageEntry = {
	type: "message",
	id: "u2",
	parentId: "root",
	timestamp: "2026-09-21T00:00:00.000Z",
	message: { role: "user", content: "the corrected prompt", timestamp: 1_758_412_800_000 },
};

describe("rpc user-message edit and tree navigation types", () => {
	it("accepts an edit_user_message command on RpcCommand", () => {
		const command: RpcCommand = editUserMessageCommand;
		expect(command).toMatchObject({
			type: "edit_user_message",
			entryId: "u1",
			text: "the corrected prompt",
			expectedLeafId: "leaf-1",
		});
	});

	it("accepts a navigate_tree command addressed by entryId with a leaf token", () => {
		const command: RpcCommand = navigateTreeCommand;
		expect(command).toMatchObject({ type: "navigate_tree", entryId: "u1", expectedLeafId: "leaf-1" });
	});

	it("keeps the shipped navigate_tree targetId spelling assignable", () => {
		const command: RpcCommand = legacyNavigateTreeCommand;
		expect(command).toMatchObject({ type: "navigate_tree", targetId: "a9" });
	});

	it("accepts expectedLeafId alongside either navigate_tree spelling", () => {
		const byTargetId: RpcCommand = guardedLegacyNavigateTreeCommand;
		const byEntryId: RpcCommand = navigateTreeCommand;
		expect(byTargetId).toMatchObject({ targetId: "a9", expectedLeafId: "leaf-1" });
		expect(byEntryId).toMatchObject({ entryId: "u1", expectedLeafId: "leaf-1" });
	});

	it("accepts exact-leaf intent with either existing address", () => {
		const entry = {
			type: "navigate_tree",
			entryId: "u1",
			intent: "resume",
			expectedLeafId: "a1",
		} satisfies RpcCommand;
		const target = {
			type: "navigate_tree",
			targetId: "u1",
			intent: "resume",
			expectedLeafId: "a1",
		} satisfies RpcCommand;
		expect(entry.intent).toBe("resume");
		expect(target.intent).toBe("resume");
	});

	it("rejects an unknown navigation intent", () => {
		// @ts-expect-error - only select and resume are navigation intents.
		const command: RpcCommand = { type: "navigate_tree", entryId: "u1", intent: "unknown" };
		expect(command.type).toBe("navigate_tree");
	});

	it("rejects a navigate_tree that addresses its target twice", () => {
		// @ts-expect-error - exactly one address is required; the spellings use different response shapes.
		const bothSpellings: RpcCommand = { type: "navigate_tree", entryId: "u1", targetId: "a9" };
		expect(bothSpellings).toMatchObject({ type: "navigate_tree" });
	});

	it("rejects a navigate_tree that addresses no target at all", () => {
		// @ts-expect-error - one of entryId / targetId is required; neither names nothing to move to.
		const noSpelling: RpcCommand = { type: "navigate_tree", summarize: true };
		expect(noSpelling).toMatchObject({ type: "navigate_tree" });
	});

	it("reports the leaf on the legacy navigate_tree response, null included", () => {
		const emptiedSession: RpcResponse = {
			type: "response",
			command: "navigate_tree",
			success: true,
			data: { cancelled: false, editorText: "the original prompt", leafId: null },
		};
		const moved: RpcResponse = {
			type: "response",
			command: "navigate_tree",
			success: true,
			data: { cancelled: false, aborted: false, leafId: "a9" },
		};
		expect(emptiedSession).toMatchObject({ data: { leafId: null } });
		expect(moved).toMatchObject({ data: { leafId: "a9" } });
	});

	it("answers an entryId navigation with NavigateTreeResult on the same response member", () => {
		const navigated: RpcResponse = {
			type: "response",
			command: "navigate_tree",
			success: true,
			data: { outcome: "navigated", leafId: null, editorText: "the original prompt" },
		};
		expect(navigated).toMatchObject({ data: { outcome: "navigated", leafId: null } });
	});

	it("rejects a navigate_tree response that omits the leaf", () => {
		const missingLeafId: RpcResponse = {
			type: "response",
			command: "navigate_tree",
			success: true,
			// @ts-expect-error - every navigate_tree outcome reports the leaf it left the session on,
			// so a client resynchronizes in one round trip instead of guessing.
			data: { cancelled: true, aborted: true },
		};
		expect(missingLeafId).toMatchObject({ success: true });
	});

	it("carries not_user in the shared RpcErrorCode union beside not_assistant", () => {
		const notUserIsAnRpcErrorCode: RpcErrorCode = RPC_ERROR_NOT_USER;
		const notAssistantIsAnRpcErrorCode: RpcErrorCode = RPC_ERROR_NOT_ASSISTANT;
		expect(notUserIsAnRpcErrorCode).toBe("not_user");
		expect(notAssistantIsAnRpcErrorCode).toBe("not_assistant");
	});

	it("reports a refusal through the catch-all failure response, whose errorCode stays a plain string", () => {
		const refusal: RpcResponse = {
			id: "req-1",
			type: "response",
			command: "edit_user_message",
			success: false,
			error: "Entry u1 is not a user message",
			errorCode: RPC_ERROR_NOT_USER,
		};
		expect(refusal).toMatchObject({ success: false, errorCode: "not_user" });
	});

	it("types an edited user message with its appended entry and leaf", () => {
		const edited: EditUserMessageResult = {
			outcome: "edited",
			entry: editedEntry,
			leafId: "u2",
			summaryEntryId: "s1",
		};
		expect(edited).toMatchObject({ outcome: "edited", leafId: "u2", summaryEntryId: "s1" });
	});

	it("types an unchanged user edit with a null leafId", () => {
		const unchanged: EditUserMessageResult = { outcome: "unchanged", leafId: null };
		const cancelled: EditUserMessageResult = { outcome: "cancelled", leafId: null, aborted: true };
		expect(unchanged.leafId).toBeNull();
		expect(cancelled).toMatchObject({ outcome: "cancelled", leafId: null, aborted: true });
	});

	it("rejects a user-edit result that omits leafId", () => {
		// @ts-expect-error - every EditUserMessageResult outcome reports the leaf, so a client
		// always resynchronizes in one round trip. Losing this error means losing that guarantee.
		const missingLeafId: EditUserMessageResult = { outcome: "unchanged" };
		expect(missingLeafId).toEqual({ outcome: "unchanged" });
	});

	it("types a navigated outcome with no editorText and one that carries it", () => {
		const toAssistantTarget: NavigateTreeResult = { outcome: "navigated", leafId: "a9" };
		const toRootUserTarget: NavigateTreeResult = {
			outcome: "navigated",
			leafId: null,
			editorText: "the original prompt",
			summaryEntryId: "s1",
		};
		expect(toAssistantTarget).not.toHaveProperty("editorText");
		expect(toRootUserTarget).toMatchObject({ leafId: null, editorText: "the original prompt" });
	});

	it("types a cancelled navigation with a null leafId", () => {
		const cancelled: NavigateTreeResult = { outcome: "cancelled", leafId: null, aborted: true };
		expect(cancelled).toMatchObject({ outcome: "cancelled", leafId: null, aborted: true });
	});
});
