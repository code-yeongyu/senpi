import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeResult } from "../../src/core/agent-session-runtime.ts";
import type { SessionBeforeTreeEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import type { EditUserMessageResult, RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";
import { makeSink, type RpcRecord } from "./rpc-connection-harness.ts";

const harnesses: Harness[] = [];
const handlers: RpcConnectionHandler[] = [];
const routers: SessionCommandRouter[] = [];
let requestId = 0;

afterEach(async () => {
	for (const router of routers.splice(0)) await router.dispose();
	for (const handler of handlers.splice(0)) await handler.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

async function conversation(options: HarnessOptions = {}) {
	const harness = await createHarness({ persistSession: true, ...options });
	harnesses.push(harness);
	const manager = harness.sessionManager;
	// Seed a true root prompt, not one parented under a model/thinking metadata entry.
	manager.resetLeaf();
	const root = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const assistant = manager.appendMessage(fauxAssistantMessage("one"));
	const user = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
	const leaf = manager.appendMessage(fauxAssistantMessage("two"));
	harness.agent.state.messages = manager.buildSessionContext().messages;
	return { harness, manager, root, assistant, user, leaf };
}

async function connection(options: HarnessOptions = {}) {
	const fixture = await conversation(options);
	const sink = makeSink();
	const runtime = {
		session: fixture.harness.session,
		setRebindSession: vi.fn(),
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	const handler = createRpcConnectionHandler(runtime, sink.sink);
	handlers.push(handler);
	await handler.ready;
	const send = async (command: object): Promise<RpcRecord> => {
		const id = `tree-${++requestId}`;
		const response = sink.waitFor((record) => record.type === "response" && record.id === id);
		await handler.handleInputLine(JSON.stringify({ ...command, id }));
		return response;
	};
	return { ...fixture, send };
}

function fileText(harness: Harness): string {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("expected a persisted session");
	return readFileSync(file, "utf8");
}

function edited(response: RpcRecord): Extract<EditUserMessageResult, { outcome: "edited" }> {
	expect(response.success).toBe(true);
	const result = response.data as EditUserMessageResult;
	expect(result.outcome).toBe("edited");
	if (result.outcome !== "edited") throw new Error("expected an edited entry");
	return result;
}

function expectRefusal(response: RpcRecord, leafId: string | null, errorCode?: string): void {
	expect(response).toMatchObject({ success: false, errorData: { leafId } });
	expect(response.errorCode).toBe(errorCode);
}

describe("RPC edit_user_message", () => {
	it("appends the edited prompt under its original parent, preserving the abandoned tree without a turn", async () => {
		const { harness, manager, assistant, user, leaf, send } = await connection();
		const count = manager.getEntries().length;
		const before = fileText(harness);
		const call = vi.spyOn(harness.session, "editUserMessage");
		harness.setResponses([fauxAssistantMessage("must not run")]);

		const data = edited(
			await send({
				type: "edit_user_message",
				entryId: user,
				text: "  revised second  ",
				expectedLeafId: leaf,
				summarize: false,
				customInstructions: "retain decisions",
			}),
		);

		expect(call).toHaveBeenCalledWith(user, "  revised second  ", {
			expectedLeafId: leaf,
			summarize: false,
			customInstructions: "retain decisions",
		});
		expect(data.entry.parentId).toBe(assistant);
		expect(data.entry.message.role).toBe("user");
		expect(getMessageText(data.entry.message)).toBe("revised second");
		expect(data.leafId).toBe(data.entry.id);
		expect(data.summaryEntryId).toBeUndefined();
		expect(manager.getLeafId()).toBe(data.entry.id);
		expect(manager.getEntries()).toHaveLength(count + 1);
		expect(fileText(harness).startsWith(before)).toBe(true);
		expect(manager.getEntry(user)).toBeDefined();
		expect(manager.getEntry(leaf)).toBeDefined();
		expect(manager.getBranch().map((entry) => entry.id)).not.toContain(user);
		expect(harness.session.messages.map(getMessageText)).toEqual(["first", "one", "revised second"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("reports unchanged with the current leaf and zero writes", async () => {
		const { harness, user, leaf, send } = await connection();
		const before = fileText(harness);
		const response = await send({ type: "edit_user_message", entryId: user, text: " second\n" });
		expect(response).toMatchObject({ success: true, data: { outcome: "unchanged", leafId: leaf } });
		expect(fileText(harness)).toBe(before);
	});

	it("reports extension cancellation with the unchanged leaf and zero writes", async () => {
		const { harness, user, leaf, send } = await connection({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		const before = fileText(harness);
		const response = await send({ type: "edit_user_message", entryId: user, text: "revised" });
		expect(response).toMatchObject({ success: true, data: { outcome: "cancelled", leafId: leaf } });
		expect(fileText(harness)).toBe(before);
	});

	it("reports an aborted summary as cancelled without losing the leaf", async () => {
		const { harness, user, leaf, send } = await connection();
		const before = fileText(harness);
		harness.setResponses([
			() => {
				harness.session.abortBranchSummary();
				return fauxAssistantMessage("unused summary");
			},
		]);
		const response = await send({ type: "edit_user_message", entryId: user, text: "revised", summarize: true });
		expect(response).toMatchObject({ success: true, data: { outcome: "cancelled", leafId: leaf, aborted: true } });
		expect(fileText(harness)).toBe(before);
	});

	it("reports the summary entry and forwards the caller's summary instructions", async () => {
		const preparations: SessionBeforeTreeEvent["preparation"][] = [];
		const { manager, user, leaf, send } = await connection({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", (event) => {
						preparations.push(event.preparation);
						return { summary: { summary: "abandoned branch" } };
					});
				},
			],
		});
		const data = edited(
			await send({
				type: "edit_user_message",
				entryId: user,
				text: "revised",
				summarize: true,
				customInstructions: "keep decisions",
				expectedLeafId: leaf,
			}),
		);
		expect(data.summaryEntryId).toBeDefined();
		expect(data.entry.parentId).toBe(data.summaryEntryId);
		expect(manager.getEntry(data.summaryEntryId!)).toMatchObject({
			type: "branch_summary",
			summary: "abandoned branch",
		});
		expect(preparations).toHaveLength(1);
		expect(preparations[0]).toMatchObject({
			targetId: user,
			userWantsSummary: true,
			customInstructions: "keep decisions",
		});
	});

	it.each(["not_found", "not_user", "empty", "stale_leaf"] as const)(
		"returns %s, the intact leaf, and zero writes",
		async (code) => {
			const { harness, manager, assistant, user, leaf, send } = await connection();
			const before = fileText(harness);
			const response = await send({
				type: "edit_user_message",
				entryId: code === "not_found" ? "missing" : code === "not_user" ? assistant : user,
				text: code === "empty" ? " \n" : "revised",
				...(code === "stale_leaf" ? { expectedLeafId: "definitely-stale" } : {}),
			});
			expectRefusal(response, leaf, code);
			expect(manager.getLeafId()).toBe(leaf);
			expect(fileText(harness)).toBe(before);
		},
	);

	it("refuses stale unchanged text and an empty-string token rather than replacing the token", async () => {
		const { user, leaf, send } = await connection();
		for (const expectedLeafId of ["definitely-stale", ""]) {
			expectRefusal(
				await send({ type: "edit_user_message", entryId: user, text: "second", expectedLeafId }),
				leaf,
				"stale_leaf",
			);
		}
	});

	it("returns streaming before stale_leaf while a real faux turn is active", async () => {
		const { harness, manager, user, send } = await connection();
		let refused: RpcRecord | undefined;
		let currentLeaf: string | null = null;
		harness.setResponses([
			async () => {
				currentLeaf = manager.getLeafId();
				const before = fileText(harness);
				refused = await send({
					type: "edit_user_message",
					entryId: user,
					text: "revised",
					expectedLeafId: "stale",
				});
				expect(fileText(harness)).toBe(before);
				expect(manager.getLeafId()).toBe(currentLeaf);
				return fauxAssistantMessage("three");
			},
		]);
		await harness.session.prompt("third");
		if (!refused) throw new Error("streaming edit was not attempted");
		expectRefusal(refused, currentLeaf, "streaming");
	});

	it.each([{ entryId: "", text: "x" }, { entryId: "missing" }, { entryId: 1, text: "x" }])(
		"returns the leaf for malformed input %j",
		async (payload) => {
			const { harness, leaf, send } = await connection();
			const before = fileText(harness);
			expectRefusal(await send({ type: "edit_user_message", ...payload }), leaf);
			expect(fileText(harness)).toBe(before);
		},
	);

	it("returns the leaf on an untyped core refusal without hiding its error", async () => {
		const { harness, user, leaf, send } = await connection();
		vi.spyOn(harness.session, "editUserMessage").mockRejectedValueOnce(new Error("summary unavailable"));
		const response = await send({ type: "edit_user_message", entryId: user, text: "revised" });
		expectRefusal(response, leaf);
		expect(response.error).toBe("summary unavailable");
	});

	it("edits the ROOT prompt into a new root with no old context and preserves the old tree on disk", async () => {
		const { harness, manager, root, leaf, send } = await connection();
		const before = fileText(harness);
		expect(manager.getEntry(root)?.parentId).toBeNull();
		const data = edited(
			await send({ type: "edit_user_message", entryId: root, text: "new root", expectedLeafId: leaf }),
		);
		expect(data.entry.parentId).toBeNull();
		expect(data.leafId).toBe(data.entry.id);
		expect(manager.getBranch()).toEqual([data.entry]);
		expect(harness.session.messages.map(getMessageText)).toEqual(["new root"]);
		expect(fileText(harness).startsWith(before)).toBe(true);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getLeafId()).toBe(data.entry.id);
		expect(reopened.getEntry(root)).toBeDefined();
		expect(reopened.getEntry(leaf)).toBeDefined();
		expect(reopened.buildSessionContext().messages.map(getMessageText)).toEqual(["new root"]);
	});
});

// #1926: exact-leaf resumption must not change the released retry-selection contract.
describe.each(["entryId", "targetId"] as const)("RPC navigate_tree intent via %s", (address) => {
	it.each(["user", "assistant"] as const)("resumes an edited branch ending in %s at its exact leaf", async (role) => {
		const beforeTree = vi.fn();
		const tree = vi.fn();
		const { harness, manager, user, leaf, send } = await connection({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", (event) => {
						beforeTree(event);
					});
					pi.on("session_tree", (event) => {
						tree(event);
					});
				},
			],
		});
		const edit = edited(await send({ type: "edit_user_message", entryId: user, text: "edited branch" }));
		const target = role === "user" ? edit.entry.id : manager.appendMessage(fauxAssistantMessage("branch answer"));
		await send({ type: "navigate_tree", entryId: leaf });
		const entries = manager.getEntries();
		const before = fileText(harness);
		beforeTree.mockClear();
		tree.mockClear();
		const call = vi.spyOn(harness.session, "navigateTree");
		const response = await send({ type: "navigate_tree", [address]: target, intent: "resume", expectedLeafId: leaf });
		expect(response.success).toBe(true);
		expect(response.data).toEqual(
			address === "entryId" ? { outcome: "navigated", leafId: target } : { cancelled: false, leafId: target },
		);
		expect(response.data).not.toHaveProperty("editorText");
		expect(call).toHaveBeenCalledWith(target, expect.objectContaining({ intent: "resume", expectedLeafId: leaf }));
		expect(manager.getLeafId()).toBe(target);
		expect(manager.getEntries()).toEqual(entries);
		expect(fileText(harness)).toBe(before);
		expect(harness.session.messages.map(getMessageText)).toEqual([
			"first",
			"one",
			"edited branch",
			...(role === "assistant" ? ["branch answer"] : []),
		]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(beforeTree).toHaveBeenCalledOnce();
		expect(tree).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ oldLeafId: leaf, newLeafId: target }));
		// Even the current user leaf resumes in place instead of becoming a retry selection.
		const again = await send({ type: "navigate_tree", [address]: target, intent: "resume", expectedLeafId: target });
		expect(again.data).toEqual(response.data);
		expect(manager.getLeafId()).toBe(target);
	});

	it.each(["root", "custom", "compaction"] as const)("resumes a %s entry itself without editor text", async (kind) => {
		const { manager, root, assistant, send } = await connection();
		const target =
			kind === "root"
				? root
				: kind === "custom"
					? manager.appendCustomMessageEntry("notice", "custom text", true)
					: manager.appendCompaction("old work", assistant, 100);
		const current = manager.appendMessage(fauxAssistantMessage("another branch"));
		const response = await send({
			type: "navigate_tree",
			[address]: target,
			intent: "resume",
			expectedLeafId: current,
		});
		expect(response.success).toBe(true);
		expect(response.data).not.toHaveProperty("editorText");
		expect(manager.getLeafId()).toBe(target);
	});

	it.each([undefined, "select"])("preserves byte-for-byte retry payloads with intent %j", async (intent) => {
		const { manager, root, user, assistant, leaf, send } = await connection();
		const custom = manager.appendCustomMessageEntry("notice", "custom text", true);
		for (const [target, parent, text] of [
			[user, assistant, "second"],
			[root, null, "first"],
			[custom, leaf, "custom text"],
		]) {
			const response = await send({ type: "navigate_tree", [address]: target, intent });
			expect(response.success).toBe(true);
			expect(JSON.stringify(response.data)).toBe(
				JSON.stringify(
					address === "entryId"
						? { outcome: "navigated", leafId: parent, editorText: text }
						: { editorText: text, cancelled: false, leafId: parent },
				),
			);
			expect(manager.getLeafId()).toBe(parent);
		}
	});

	it("forwards stale and empty resume tokens verbatim before events or writes", async () => {
		const beforeTree = vi.fn();
		const { harness, manager, user, leaf, send } = await connection({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", (event) => {
						beforeTree(event);
					});
				},
			],
		});
		const call = vi.spyOn(harness.session, "navigateTree");
		const before = fileText(harness);
		const entries = manager.getEntries();
		const messages = [...harness.session.messages];
		for (const expectedLeafId of ["stale-token", ""]) {
			// Current-leaf targets must not bypass the concurrency guard either.
			for (const target of [user, leaf]) {
				expectRefusal(
					await send({ type: "navigate_tree", [address]: target, intent: "resume", expectedLeafId }),
					leaf,
					"stale_leaf",
				);
				expect(call).toHaveBeenLastCalledWith(
					target,
					expect.objectContaining({ intent: "resume", expectedLeafId }),
				);
			}
		}
		expect(beforeTree).not.toHaveBeenCalled();
		expect(manager.getLeafId()).toBe(leaf);
		expect(manager.getEntries()).toEqual(entries);
		expect(harness.session.messages).toEqual(messages);
		expect(fileText(harness)).toBe(before);
	});

	it("shares extension cancellation without changing the leaf", async () => {
		const tree = vi.fn();
		const { harness, manager, user, leaf, send } = await connection({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
					pi.on("session_tree", (event) => {
						tree(event);
					});
				},
			],
		});
		const before = fileText(harness);
		const response = await send({ type: "navigate_tree", [address]: user, intent: "resume", expectedLeafId: leaf });
		expect(response.data).toEqual(
			address === "entryId" ? { outcome: "cancelled", leafId: leaf } : { cancelled: true, leafId: leaf },
		);
		expect(manager.getLeafId()).toBe(leaf);
		expect(fileText(harness)).toBe(before);
		expect(tree).not.toHaveBeenCalled();
	});

	it("shares summaries and labels without replacing the requested resume leaf", async () => {
		const beforeTree = vi.fn();
		const tree = vi.fn();
		const { harness, manager, user, leaf, send } = await connection({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", (event) => {
						beforeTree(event);
						return { summary: { summary: "abandoned work" } };
					});
					pi.on("session_tree", (event) => {
						tree(event);
					});
				},
			],
		});
		const response = await send({
			type: "navigate_tree",
			[address]: user,
			intent: "resume",
			expectedLeafId: leaf,
			summarize: true,
			customInstructions: "retain decisions",
			replaceInstructions: true,
			label: "checkpoint",
		});
		expect(response.success).toBe(true);
		expect(response.data).toMatchObject({ leafId: user });
		expect(response.data).not.toHaveProperty("editorText");
		const summary = manager.getEntries().find((entry) => entry.type === "branch_summary");
		expect(summary).toMatchObject({ parentId: user, summary: "abandoned work" });
		expect(manager.getLabel(summary!.id)).toBe("checkpoint");
		expect(response.data).toMatchObject(
			address === "entryId" ? { summaryEntryId: summary!.id } : { summaryEntry: summary },
		);
		expect(beforeTree).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				preparation: expect.objectContaining({
					targetId: user,
					oldLeafId: leaf,
					userWantsSummary: true,
					customInstructions: "retain decisions",
					replaceInstructions: true,
					label: "checkpoint",
				}),
			}),
		);
		expect(tree).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ newLeafId: user, oldLeafId: leaf, summaryEntry: summary, fromExtension: true }),
		);
		expect(manager.getLeafId()).toBe(user);
		expect(harness.session.messages.map(getMessageText)).toEqual(["first", "one", "second"]);
		const labelled = await send({
			type: "navigate_tree",
			[address]: user,
			intent: "resume",
			expectedLeafId: user,
			label: "user tail",
		});
		expect(labelled.data).toMatchObject({ leafId: user });
		expect(manager.getLabel(user)).toBe("user tail");
	});

	it("shares summary abort and streaming refusal", async () => {
		const { harness, manager, user, leaf, send } = await connection();
		const before = fileText(harness);
		harness.setResponses([
			() => {
				harness.session.abortBranchSummary();
				return fauxAssistantMessage("unused");
			},
		]);
		const response = await send({ type: "navigate_tree", [address]: user, intent: "resume", summarize: true });
		expect(response.data).toMatchObject({ leafId: leaf, aborted: true });
		expect(manager.getLeafId()).toBe(leaf);
		expect(fileText(harness)).toBe(before);
		harness.setResponses([
			async () => {
				expectRefusal(
					await send({ type: "navigate_tree", [address]: user, intent: "resume" }),
					manager.getLeafId(),
					"streaming",
				);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("third");
	});

	it.each(["unknown", "", null, true])(
		"refuses invalid intent %j instead of silently selecting a prompt",
		async (intent) => {
			const { harness, manager, user, leaf, send } = await connection();
			const before = fileText(harness);
			const call = vi.spyOn(harness.session, "navigateTree");
			expectRefusal(await send({ type: "navigate_tree", [address]: user, intent }), leaf);
			expect(call).not.toHaveBeenCalled();
			expect(manager.getLeafId()).toBe(leaf);
			expect(fileText(harness)).toBe(before);
		},
	);
});

describe("RPC navigate_tree", () => {
	it("selects a user entry's PARENT and returns the text to the editor", async () => {
		const { harness, manager, assistant, user, leaf, send } = await connection();
		const before = fileText(harness);
		const response = await send({ type: "navigate_tree", entryId: user, expectedLeafId: leaf });
		expect(response).toMatchObject({
			success: true,
			data: { outcome: "navigated", leafId: assistant, editorText: "second" },
		});
		expect(manager.getLeafId()).toBe(assistant);
		expect(harness.session.messages.map(getMessageText)).toEqual(["first", "one"]);
		expect(fileText(harness)).toBe(before);
	});

	it("selects an assistant entry itself and omits editorText", async () => {
		const { harness, manager, assistant, leaf, send } = await connection();
		const response = await send({ type: "navigate_tree", entryId: assistant, expectedLeafId: leaf });
		expect(response).toMatchObject({ success: true, data: { outcome: "navigated", leafId: assistant } });
		expect(response.data).not.toHaveProperty("editorText");
		expect(manager.getLeafId()).toBe(assistant);
		expect(harness.session.messages.map(getMessageText)).toEqual(["first", "one"]);
	});

	it("selects a custom message's parent and returns only its text content", async () => {
		const { manager, leaf, send } = await connection();
		const custom = manager.appendCustomMessageEntry(
			"notice",
			[
				{ type: "text", text: "custom text" },
				{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
			],
			true,
		);
		manager.appendMessage(fauxAssistantMessage("after custom"));
		const response = await send({ type: "navigate_tree", entryId: custom });
		expect(response).toMatchObject({
			success: true,
			data: { outcome: "navigated", leafId: leaf, editorText: "custom text" },
		});
		expect(manager.getLeafId()).toBe(leaf);
	});

	it("selects a non-message entry itself without editorText", async () => {
		const { manager, assistant, send } = await connection();
		const compaction = manager.appendCompaction("old work", assistant, 100);
		manager.appendMessage(fauxAssistantMessage("after compaction"));
		const response = await send({ type: "navigate_tree", entryId: compaction });
		expect(response).toMatchObject({ success: true, data: { outcome: "navigated", leafId: compaction } });
		expect(response.data).not.toHaveProperty("editorText");
		expect(manager.getLeafId()).toBe(compaction);
	});

	it("selects the ROOT prompt into an empty conversation, returns its text, and preserves the old tree", async () => {
		const { harness, manager, root, leaf, send } = await connection();
		const before = fileText(harness);
		const entries = manager.getEntries();
		expect(manager.getEntry(root)?.parentId).toBeNull();
		const response = await send({ type: "navigate_tree", entryId: root, expectedLeafId: leaf });
		expect(response).toMatchObject({
			success: true,
			data: { outcome: "navigated", leafId: null, editorText: "first" },
		});
		expect(manager.getLeafId()).toBeNull();
		expect(manager.getBranch()).toEqual([]);
		expect(harness.session.messages).toEqual([]);
		expect(manager.getEntries()).toEqual(entries);
		expect(fileText(harness)).toBe(before);
		// A subsequent unchanged edit/refusal must preserve the nullable resynchronization token.
		expect(await send({ type: "edit_user_message", entryId: root, text: "first" })).toMatchObject({
			success: true,
			data: { outcome: "unchanged", leafId: null },
		});
		expectRefusal(await send({ type: "edit_user_message", entryId: root, text: " " }), null, "empty");
	});

	it.each(["root user", "user", "custom"] as const)("preserves targetId selection of a %s entry", async (kind) => {
		const { harness, manager, root, user, leaf, assistant, send } = await connection();
		const targetId =
			kind === "root user"
				? root
				: kind === "user"
					? user
					: manager.appendCustomMessageEntry("notice", "custom text", true);
		if (kind === "custom") manager.appendMessage(fauxAssistantMessage("after custom"));
		const parentId = kind === "root user" ? null : kind === "user" ? assistant : leaf;
		const editorText = kind === "root user" ? "first" : kind === "user" ? "second" : "custom text";
		const before = fileText(harness);
		const response = await send({ type: "navigate_tree", targetId });
		expect(response).toMatchObject({ success: true, data: { cancelled: false, leafId: parentId, editorText } });
		expect(response.data).not.toHaveProperty("outcome");
		expect(manager.getLeafId()).toBe(parentId);
		expect(fileText(harness)).toBe(before);
	});

	it.each(["root", "non-root"] as const)(
		"retrying the most recent %s user message selects its parent and resubmits without duplication",
		async (kind) => {
			const beforeTree = vi.fn();
			const tree = vi.fn();
			const { harness, manager, root, user, send } = await connection({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_tree", (event) => {
							beforeTree(event);
						});
						pi.on("session_tree", (event) => {
							tree(event);
						});
					},
				],
			});
			const data = edited(
				await send({ type: "edit_user_message", entryId: kind === "root" ? root : user, text: "edited leaf" }),
			);
			expect(manager.getLeafId()).toBe(data.entry.id);
			const before = fileText(harness);
			beforeTree.mockClear();
			tree.mockClear();
			const response = await send({ type: "navigate_tree", entryId: data.leafId, expectedLeafId: data.leafId });
			expect(response).toMatchObject({
				success: true,
				data: {
					outcome: "navigated",
					leafId: data.entry.parentId,
					editorText: "edited leaf",
				},
			});
			expect(manager.getLeafId()).toBe(data.entry.parentId);
			expect(harness.session.messages.map(getMessageText)).toEqual(kind === "root" ? [] : ["first", "one"]);
			expect(fileText(harness)).toBe(before);
			expect(beforeTree).toHaveBeenCalledOnce();
			expect(tree).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					oldLeafId: data.leafId,
					newLeafId: data.entry.parentId,
				}),
			);
			let submittedPrompts: string[] = [];
			harness.setResponses([
				(context) => {
					submittedPrompts = context.messages.filter((message) => message.role === "user").map(getMessageText);
					return fauxAssistantMessage("retried");
				},
			]);
			await harness.session.prompt("edited leaf");
			expect(submittedPrompts).toEqual(kind === "root" ? ["edited leaf"] : ["first", "edited leaf"]);
			expect(manager.getBranch().map((entry) => entry.id)).not.toContain(data.entry.id);
			expect(manager.getEntry(data.entry.id)).toEqual(data.entry);
		},
	);

	it("keeps targetId's legacy response and selects an assistant entry itself", async () => {
		const { harness, manager, assistant, leaf, send } = await connection();
		const call = vi.spyOn(harness.session, "navigateTree");
		const response = await send({
			type: "navigate_tree",
			targetId: assistant,
			expectedLeafId: leaf,
			summarize: false,
			customInstructions: "retain decisions",
			replaceInstructions: true,
		});
		expect(call).toHaveBeenCalledWith(assistant, {
			expectedLeafId: leaf,
			summarize: false,
			customInstructions: "retain decisions",
			replaceInstructions: true,
			label: undefined,
		});
		expect(response).toMatchObject({ success: true, data: { cancelled: false, leafId: assistant } });
		expect(response.data).not.toHaveProperty("outcome");
		expect(manager.getLeafId()).toBe(assistant);
	});

	it.each([{}, { entryId: "user", targetId: "assistant" }])(
		"rejects ambiguous/missing addressing %j without touching the session",
		async (address) => {
			const { harness, leaf, send } = await connection();
			const before = fileText(harness);
			const call = vi.spyOn(harness.session, "navigateTree");
			expectRefusal(await send({ type: "navigate_tree", ...address }), leaf);
			expect(call).not.toHaveBeenCalled();
			expect(fileText(harness)).toBe(before);
		},
	);

	it.each(["entryId", "targetId"] as const)(
		"forwards stale/empty expectedLeafId verbatim for %s and keeps the leaf",
		async (address) => {
			const { harness, manager, assistant, leaf, send } = await connection();
			const before = fileText(harness);
			const call = vi.spyOn(harness.session, "navigateTree");
			for (const expectedLeafId of ["definitely-stale", ""]) {
				const response = await send({ type: "navigate_tree", [address]: assistant, expectedLeafId });
				expectRefusal(response, leaf, "stale_leaf");
				expect(call).toHaveBeenLastCalledWith(assistant, expect.objectContaining({ expectedLeafId }));
			}
			expect(manager.getLeafId()).toBe(leaf);
			expect(fileText(harness)).toBe(before);
		},
	);

	// #1892 follow-up: exercise the real handler/core path, not a mocked typed rejection.
	it.each(["entryId", "targetId"] as const)(
		"returns not_found for a missing %s without changing the session",
		async (address) => {
			const { harness, manager, leaf, send } = await connection();
			const before = fileText(harness);
			const entries = manager.getEntries();
			const messages = [...harness.session.messages];

			const response = await send({ type: "navigate_tree", [address]: "missing", expectedLeafId: leaf });

			expect(response).toMatchObject({ type: "response", command: "navigate_tree" });
			expectRefusal(response, leaf, "not_found");
			expect(manager.getLeafId()).toBe(leaf);
			expect(manager.getEntries()).toEqual(entries);
			expect(harness.session.messages).toEqual(messages);
			expect(fileText(harness)).toBe(before);
		},
	);

	it("reports cancellation of entry selection with the intact leaf", async () => {
		const { user, leaf, send } = await connection({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		expect(await send({ type: "navigate_tree", entryId: user })).toMatchObject({
			success: true,
			data: { outcome: "cancelled", leafId: leaf },
		});
	});

	it("reports the summary entry for entry selection and forwards all options", async () => {
		const { harness, user, leaf, send } = await connection({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ summary: { summary: "old branch" } }));
				},
			],
		});
		const call = vi.spyOn(harness.session, "navigateTree");
		const response = await send({
			type: "navigate_tree",
			entryId: user,
			summarize: true,
			expectedLeafId: leaf,
			customInstructions: "decisions",
			replaceInstructions: true,
			label: "summary",
		});
		expect(call).toHaveBeenCalledWith(user, {
			summarize: true,
			expectedLeafId: leaf,
			customInstructions: "decisions",
			replaceInstructions: true,
			label: "summary",
		});
		expect(response).toMatchObject({
			success: true,
			data: {
				outcome: "navigated",
				editorText: "second",
				leafId: expect.any(String),
				summaryEntryId: expect.any(String),
			},
		});
		const data = response.data as { leafId: string; summaryEntryId: string };
		expect(data.leafId).toBe(harness.sessionManager.getLeafId());
		// Label changes are persisted entries too: resynchronize to the actual leaf, not the summary.
		expect(harness.sessionManager.getEntry(data.leafId)).toMatchObject({
			type: "label",
			targetId: data.summaryEntryId,
			parentId: data.summaryEntryId,
			label: "summary",
		});
	});
});

describe("multi-session RPC user edits and navigation", () => {
	it.each(["edit_user_message", "navigate_tree"] as const)(
		"routes %s to the non-default session only",
		async (type) => {
			const first = await conversation();
			const second = await conversation();
			const fixtures = [first, second];
			const sink = makeSink();
			const registry = new RpcSessionRegistry({
				agentDir: join(first.harness.tempDir, "host"),
				createRuntime: async ({ cwd, agentDir }) => {
					const fixture = fixtures.find(({ harness }) => harness.tempDir === cwd);
					if (!fixture) throw new Error("unexpected session cwd");
					return {
						session: fixture.harness.session,
						diagnostics: [],
						services: { cwd, agentDir },
					} as unknown as CreateAgentSessionRuntimeResult;
				},
			});
			const writer = new SessionEventWriter(sink.sink.writeRaw, (flush) => flush());
			const router = new SessionCommandRouter(registry, writer, { cwd: first.harness.tempDir });
			routers.push(router);
			const opened: string[] = [];
			for (const fixture of fixtures) {
				const id = `open-${++requestId}`;
				const pending = sink.waitFor((record) => record.type === "response" && record.id === id);
				const failure = await router.handle({ id, type: "open_session", cwd: fixture.harness.tempDir });
				if (failure) sink.sink.writeRaw(`${JSON.stringify(failure)}\n`);
				await writer.flush();
				const response = await pending;
				expect(response.success).toBe(true);
				if (typeof response.sessionId !== "string") throw new Error("missing routing handle");
				opened.push(response.sessionId);
			}
			expect(opened[0]).not.toBe(opened[1]);
			const firstBefore = fileText(first.harness);
			const firstEntries = first.manager.getEntries();
			const secondBefore = fileText(second.harness);
			const id = `routed-${++requestId}`;
			const response = sink.waitFor((record) => record.type === "response" && record.id === id);
			const command: RpcCommand =
				type === "edit_user_message"
					? {
							id,
							type,
							sessionId: opened[1],
							entryId: second.user,
							text: "only second",
							expectedLeafId: second.leaf,
						}
					: { id, type, sessionId: opened[1], entryId: second.user, expectedLeafId: second.leaf };
			await router.handle(command);
			await writer.flush();
			const record = await response;
			expect(record).toMatchObject({ success: true, sessionId: opened[1] });
			if (type === "edit_user_message") {
				const data = edited(record);
				expect(data.entry.parentId).toBe(second.assistant);
				expect(second.manager.getLeafId()).toBe(data.leafId);
				expect(fileText(second.harness)).not.toBe(secondBefore);
			} else {
				expect(record.data).toEqual({ outcome: "navigated", leafId: second.assistant, editorText: "second" });
				expect(second.manager.getLeafId()).toBe(second.assistant);
			}
			expect(first.manager.getLeafId()).toBe(first.leaf);
			expect(first.manager.getEntries()).toEqual(firstEntries);
			expect(fileText(first.harness)).toBe(firstBefore);
			expect(first.harness.session.messages.map(getMessageText)).toEqual(["first", "one", "second", "two"]);
		},
	);
});
