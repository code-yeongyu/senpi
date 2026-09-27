import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { createRemoteSessionProxy } from "../../src/modes/interactive/interactive-host-runtime.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { RpcClient, type RpcClientEvent } from "../../src/modes/rpc/rpc-client.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";
import { createHarness } from "./harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

function nextEvent(client: RpcClient, predicate: (event: RpcClientEvent) => boolean): Promise<RpcClientEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("RPC live delta event deadline"));
		}, 10_000);
		const unsubscribe = client.onEvent((event) => {
			if (!predicate(event)) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(event);
		});
		cleanups.push(() => {
			clearTimeout(timer);
			unsubscribe();
		});
	});
}

describe("shared-host live delta delivery", () => {
	it("preserves interactive text, thinking, tool arguments and usage across live sockets and replay", async () => {
		initTheme("dark");
		const root = mkdtempSync(join(tmpdir(), "senpi-live-delta-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OFFLINE", "1");
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		cleanups.push(() => release());
		let chunks = 0;
		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: true }],
			tokenSize: { min: 4, max: 4 },
			schedulerHook: async () => {
				if (++chunks === 2) await barrier;
				// Yield to the real socket after each provider delta, with no clock-based pacing.
				await setImmediate();
			},
		});
		const thinking = "Check both paths.";
		const text = "The result is complete.";
		const args = { value: "fragmented arguments" };
		const answer = fauxAssistantMessage(
			[
				{ ...fauxThinking(thinking), thinkingSignature: "signed-thinking" },
				fauxText(text),
				fauxToolCall("image_echo", args, { id: "call-live" }),
			],
			{ stopReason: "toolUse" },
		);
		faux.setResponses([answer, fauxAssistantMessage("done")]);
		const writer = new SessionEventWriter(() => {});
		const { router, handle } = createHostCore(
			{
				agentDir,
				cwd: root,
				permissionPreset: "full-access",
				creationModel: { provider: faux.getModel().provider, modelId: faux.getModel().id },
				createRuntime: createCliRuntimeFactory(
					{
						parsed: parseArgs([
							"--mode",
							"rpc",
							"--multi-session",
							"--no-extensions",
							"--no-skills",
							"--no-context-files",
							"--no-prompt-templates",
							"--no-themes",
						]),
						cwd: root,
						agentDir,
						appMode: "rpc",
					},
					{
						extensionFactories: [
							(pi) => {
								pi.registerProvider(faux.provider);
								pi.registerTool({
									name: "image_echo",
									label: "Image echo",
									description: "Local deterministic echo",
									parameters: Type.Object({ value: Type.String() }),
									execute: async () => ({
										content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
										details: {},
									}),
								});
							},
						],
					},
				),
			},
			writer,
			[],
		);
		const sockets = new Set<Socket>();
		const failures: unknown[] = [];
		let serial = 0;
		const server = createServer((socket) => {
			const id = `socket-${++serial}`;
			sockets.add(socket);
			socket.on("error", (error) => failures.push(error));
			writer.registerConnection(id, socketSink(socket));
			const detach = attachJsonlLineReader(socket, (line) => {
				void writer.withConnection(id, () => handle(line)).catch((error) => failures.push(error));
			});
			socket.once("close", () => {
				detach();
				sockets.delete(socket);
				writer.unregisterConnection(id);
			});
		});
		const socketPath = join(root, "rpc.sock");
		server.listen(socketPath);
		await once(server, "listening");
		cleanups.push(async () => {
			release();
			await router.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		const connect = async (sessionPath?: string, capabilities: string[] = []) => {
			const client = new RpcClient({ socketPath });
			cleanups.push(() => client.stop());
			await client.start();
			await client.setClientInfo(100, capabilities);
			const hostSocket = [...sockets].at(-1);
			if (!hostSocket) throw new Error("Missing accepted socket");
			const wire: RpcClientEvent[] = [];
			client.onEvent((event) => wire.push(structuredClone(event)));
			const opened = await client.openSession({ cwd: root, sessionPath, auto_title: false });
			const mirror = await createHarness({ provider: `mirror-${serial}` });
			cleanups.push(mirror.cleanup);
			const proxy = createRemoteSessionProxy(
				mirror.session,
				agentDir,
				client,
				opened.state,
				undefined,
				undefined,
				wire,
			);
			const updates: AgentSessionEvent[] = [];
			proxy.session.subscribe((event) => updates.push(structuredClone(event)));
			return {
				client,
				wire,
				updates,
				proxy,
				opened,
				disconnect: async () => {
					const closed = once(hostSocket, "close");
					await client.stop();
					await closed;
				},
			};
		};
		const plain = await connect();
		const sessionPath = plain.opened.state.sessionFile;
		expect(sessionPath).toBeTruthy();
		const media = await connect(sessionPath, ["media_placeholders"]);
		const first = nextEvent(
			plain.client,
			(event) => event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta",
		);
		const settled = nextEvent(plain.client, (event) => event.type === "agent_settled");
		const mediaSettled = nextEvent(media.client, (event) => event.type === "agent_settled");
		const prompting = plain.client.prompt("exercise every streamed block");
		const firstDelta = await first;
		const disconnected = await connect(sessionPath);
		await disconnected.disconnect();
		const late = await connect(sessionPath);
		const lateSettled = nextEvent(late.client, (event) => event.type === "agent_settled");
		const replay = late.wire.filter((event) => event.type === "message_update");
		expect(replay.at(-1)).toMatchObject({
			message: {
				content: [
					{
						type: "thinking",
						thinking:
							firstDelta.type === "message_update" && "delta" in firstDelta.assistantMessageEvent
								? firstDelta.assistantMessageEvent.delta
								: undefined,
					},
				],
			},
		});
		// The production interactive attachment refreshes after replay.
		await late.proxy.refresh();
		release();
		await Promise.all([prompting, settled, mediaSettled, lateSettled]);
		const hostEnd = plain.wire.find((event) => event.type === "message_end" && event.message.role === "assistant");
		if (hostEnd?.type !== "message_end" || hostEnd.message.role !== "assistant")
			throw new Error("Missing host assistant message");
		const hostUsage = hostEnd.message.usage;
		expect(hostUsage.input).toBeGreaterThan(0);
		expect(hostUsage.output).toBeGreaterThan(0);
		const hostState = await plain.client.getState();

		for (const peer of [plain, media, late]) {
			const firstEnd = peer.updates.findIndex(
				(event) => event.type === "message_end" && event.message.role === "assistant",
			);
			const updates = peer.updates.slice(0, firstEnd).filter((event) => event.type === "message_update");
			const lastDelta = (type: string) => {
				const message = updates.findLast((event) => event.assistantMessageEvent.type === type)?.message;
				if (message?.role !== "assistant") throw new Error(`Missing assistant ${type}`);
				return message;
			};
			expect(lastDelta("thinking_delta").content[0]).toMatchObject({ type: "thinking", thinking });
			expect(lastDelta("text_delta").content[1]).toMatchObject({ type: "text", text });
			expect(lastDelta("toolcall_end").content[2]).toMatchObject({
				type: "toolCall",
				id: "call-live",
				name: "image_echo",
				arguments: args,
			});
			expect(lastDelta("toolcall_delta").usage).toEqual(hostUsage);
			const ended = peer.updates.find((event) => event.type === "message_end" && event.message.role === "assistant");
			expect(ended).toMatchObject({ message: { content: answer.content, usage: hostUsage } });
			expect(peer.proxy.session.sessionManager.getUsageTotals()).toEqual(hostState.usageTotals);
		}
		expect(plain.wire.find((event) => event.type === "tool_execution_end")).toMatchObject({
			result: { content: [{ type: "image", data: "aGVsbG8=" }] },
		});
		expect(media.wire.find((event) => event.type === "tool_execution_end")).toMatchObject({
			result: { content: [{ type: "image_ref", byteLength: 5 }] },
		});

		// Anthropic permits genuine initial text/thinking followed by suffix-only
		// deltas (anthropic-sse-parsing.test.ts). Full snapshots remain authoritative.
		const snapshot = fauxAssistantMessage([
			{ ...fauxThinking("Initial thinking"), thinkingSignature: "keep-signature" },
			fauxText("Initial text"),
			{
				...fauxToolCall("image_echo", { initial: "kept" }, { id: "initial-call" }),
				namespace: "tools",
				thoughtSignature: "keep-tool-signature",
			},
		]);
		const emit = async (
			type: "text_start" | "text_delta" | "thinking_start" | "thinking_delta" | "toolcall_start",
			contentIndex: number,
			delta?: string,
		) => {
			const seen = nextEvent(
				plain.client,
				(event) => event.type === "message_update" && event.assistantMessageEvent.type === type,
			);
			writer.enqueue(plain.opened.sessionId, {
				type: "message_update",
				message: structuredClone(snapshot),
				resolvedToolName: "Image echo",
				assistantMessageEvent: { type, contentIndex, delta, partial: structuredClone(snapshot) },
			});
			await seen;
		};
		await emit("text_start", 1);
		const textReplay = await connect(sessionPath);
		await textReplay.proxy.refresh();
		const replayDelta = nextEvent(
			textReplay.client,
			(event) =>
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta" &&
				event.assistantMessageEvent.delta === " plus delta",
		);
		const textBlock = snapshot.content[1];
		if (textBlock.type !== "text") throw new Error("Missing text block");
		textBlock.text += " plus delta";
		await emit("text_delta", 1, " plus delta");
		await replayDelta;
		const hydrated = textReplay.updates.at(-1);
		expect(hydrated).toMatchObject({
			resolvedToolName: "Image echo",
			message: {
				content: [
					{ thinkingSignature: "keep-signature" },
					{ text: "Initial text plus delta" },
					{
						id: "initial-call",
						arguments: { initial: "kept" },
						namespace: "tools",
						thoughtSignature: "keep-tool-signature",
					},
				],
				usage: snapshot.usage,
			},
		});
		await emit("thinking_start", 0);
		const thinkingBlock = snapshot.content[0];
		if (thinkingBlock.type !== "thinking") throw new Error("Missing thinking block");
		thinkingBlock.thinking += " plus delta";
		await emit("thinking_delta", 0, " plus delta");
		const thinkingUpdate = plain.updates.at(-1);
		expect(
			thinkingUpdate?.type === "message_update" &&
				thinkingUpdate.message.role === "assistant" &&
				thinkingUpdate.message.content[0],
		).toMatchObject({
			thinking: "Initial thinking plus delta",
			thinkingSignature: "keep-signature",
		});
		await emit("toolcall_start", 2);
		expect(plain.updates.at(-1)).toMatchObject({ message: { content: snapshot.content } });

		// A reconnecting listener sees every cached record. text_start seeds its
		// assistant state before demoted deltas; the newest full snapshot settles it.
		await textReplay.proxy.refresh();
		await textReplay.disconnect();
		textBlock.text = "Replay: ";
		await emit("text_start", 1);
		for (let index = 0; index < 20; index++) {
			textBlock.text += `${index},`;
			await emit("text_delta", 1, `${index},`);
		}
		const replayOffset = textReplay.updates.length;
		const wireOffset = textReplay.wire.length;
		await textReplay.client.start();
		await textReplay.client.openSession({ cwd: root, sessionPath, auto_title: false });
		const replayUpdates = textReplay.updates.slice(replayOffset).filter((event) => event.type === "message_update");
		expect(replayUpdates).toHaveLength(21);
		expect(replayUpdates.every((event) => event.message?.role === "assistant")).toBe(true);
		for (const event of replayUpdates) {
			expect(event).toMatchObject({ resolvedToolName: "Image echo", message: { usage: snapshot.usage } });
		}
		expect(replayUpdates.at(-1)?.message).toEqual(snapshot);
		expect(
			textReplay.wire
				.slice(wireOffset)
				.filter((event) => event.type === "message_update" && (event as { message?: unknown }).message === null),
		).toHaveLength(19);
		const finished = nextEvent(textReplay.client, (event) => event.type === "message_end");
		writer.enqueue(plain.opened.sessionId, { type: "message_end", message: snapshot });
		await finished;
		expect(failures).toEqual([]);
	}, 30_000);
});
