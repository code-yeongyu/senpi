import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { contextHost, responseData } from "./rpc-session-context-support.ts";

// `open_session.promptSurface` makes the prompt surface a per-session property of a shared
// host: one host process serves a terminal client and an app client at once.
const ROUTING_LINE = "I read this as";
const FEEDBACK_GUIDANCE = /tool and hook feedback/i;
const HANDOFF_SLOT = /For you|You need/;

afterEach(() => {
	vi.unstubAllEnvs();
});

it("builds each session's prompt from the promptSurface its open_session carried", async () => {
	vi.stubEnv("SENPI_PROMPT_SURFACE", undefined);
	await using host = await contextHost();

	const terminal = await host.open("conn-terminal", { promptSurface: "terminal" });
	const app = await host.open("conn-app", { promptSurface: "app" });

	const terminalPrompt = host.systemPrompt(String(terminal.sessionId));
	const appPrompt = host.systemPrompt(String(app.sessionId));
	expect(terminalPrompt).toContain(ROUTING_LINE);
	expect(terminalPrompt).not.toMatch(FEEDBACK_GUIDANCE);
	expect(appPrompt).not.toContain(ROUTING_LINE);
	expect(appPrompt).toMatch(FEEDBACK_GUIDANCE);
}, 120_000);

it("follows SENPI_PROMPT_SURFACE when open_session carries no promptSurface", async () => {
	vi.stubEnv("SENPI_PROMPT_SURFACE", "app");
	await using host = await contextHost();

	const opened = await host.open("conn-a", {});

	expect(host.systemPrompt(String(opened.sessionId))).not.toContain(ROUTING_LINE);
	expect(host.systemPrompt(String(opened.sessionId))).toMatch(FEEDBACK_GUIDANCE);
}, 120_000);

it("rebuilds an attached session's prompt when a later open names another surface", async () => {
	vi.stubEnv("SENPI_PROMPT_SURFACE", undefined);
	await using host = await contextHost();
	const sessionPath = join(host.scratch, "shared.jsonl");
	const first = await host.open("conn-a", { sessionPath, promptSurface: "terminal" });
	expect(host.systemPrompt(String(first.sessionId))).toContain(ROUTING_LINE);

	const attached = await host.open("conn-b", { sessionPath, promptSurface: "app" });

	expect(attached.sessionId).toBe(first.sessionId);
	expect(host.systemPrompt(String(first.sessionId))).not.toContain(ROUTING_LINE);

	await host.open("conn-c", { sessionPath });
	expect(host.systemPrompt(String(first.sessionId))).not.toContain(ROUTING_LINE);
}, 120_000);

it("builds a chat-surface prompt with no routing line and no handoff block", async () => {
	vi.stubEnv("SENPI_PROMPT_SURFACE", undefined);
	await using host = await contextHost();

	const chat = await host.open("conn-chat", { promptSurface: "chat" });

	const chatPrompt = host.systemPrompt(String(chat.sessionId));
	expect(chatPrompt).not.toContain(ROUTING_LINE);
	expect(chatPrompt).not.toMatch(HANDOFF_SLOT);
	expect(chatPrompt).toMatch(FEEDBACK_GUIDANCE);
}, 120_000);

it("refuses a promptSurface outside terminal, app and chat at the RPC boundary", async () => {
	await using host = await contextHost();

	const error = await host.openFailure("conn-a", { promptSurface: "web" });

	expect(error).toContain("promptSurface");
}, 120_000);

it("advertises that it honors open_session.promptSurface", async () => {
	await using host = await contextHost();

	const info = responseData(await host.send("conn-a", { type: "get_protocol_info" }));

	expect(z.array(z.string()).parse(info.capabilities)).toContain("prompt_surface");
	expect(z.array(z.string()).parse(info.capabilities)).toContain("prompt_surface_chat");
}, 120_000);
