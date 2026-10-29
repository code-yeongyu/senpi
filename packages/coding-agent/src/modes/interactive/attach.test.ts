import { EventEmitter, once } from "node:events";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { parseArgs } from "../../cli/args.ts";
import { resolveSocketTransportAddress } from "../rpc/socket-transport.ts";
import { type EndpointOptions, endpoint } from "../../../test/helpers/attach-endpoint.ts";
import { AttachedTui, validateAttachTerminal } from "./attach.ts";
import { AttachClient } from "./attach-client.ts";
import { RecordRenderer } from "./record-renderer.ts";
import { initTheme } from "./theme/theme.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant: AssistantMessage = {
	role: "assistant",
	api: "openai-completions",
	provider: "fixture",
	model: "fixture",
	content: [{ type: "text", text: "Streamed answer" }],
	usage,
	stopReason: "stop",
	timestamp: 2,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function attached(options: EndpointOptions = {}, answerDeadlineMs?: number) {
	initTheme("dark");
	const host = await endpoint(options);
	cleanups.push(host.close);
	const ui = new TUI(new VirtualTerminal(80, 24));
	const renders = new EventEmitter();
	ui.requestRender = () => {
		renders.emit("render");
	};
	const view = new AttachedTui(ui, () => {}, { answerDeadlineMs });
	cleanups.push(() => view.close());
	await view.connect(host.path, "durable");
	const screen = () => view.render(80).join("\n");
	/** Waits, render by render, until the screen satisfies `predicate`. */
	const until = async (predicate: (screen: string) => boolean) => {
		const signal = AbortSignal.timeout(5000);
		while (!predicate(screen())) await once(renders, "render", { signal });
	};
	return {
		host,
		view,
		screen,
		until,
		nextRender: () => once(renders, "render", { signal: AbortSignal.timeout(5000) }),
	};
}

const permissionRequest = {
	type: "extension_ui_request",
	id: "permission",
	method: "select",
	title: "Allow operation?",
	options: ["Allow", "Deny"],
} as const;

// #4269: drive the real local socket, editor and renderer, not a mocked client.
describe("attached interactive TUI", () => {
	it("keeps distinct persisted entries that share a timestamp", () => {
		initTheme("dark");
		const renderer = new RecordRenderer();
		renderer.prepend(
			["First message", "Second message"].map((content, index) => ({
				type: "message",
				id: `entry-${index}`,
				parentId: null,
				timestamp: "2026-01-01",
				message: { role: "user", content, timestamp: 1 },
			})),
		);
		expect(renderer.render(80).join("\n")).toContain("First message");
		expect(renderer.render(80).join("\n")).toContain("Second message");
	});

	it("renders a scripted turn and forwards input and permission answers", async () => {
		const { host, view, nextRender } = await attached();
		expect(view.render(80).join("\n")).toContain("Previous question");
		view.handleInput("New question");
		view.handleInput("\r");
		const prompt = await host.command("prompt");
		expect(prompt).toMatchObject({ sessionId: "live", message: "New question" });
		expect(prompt.clientMessageId).toEqual(expect.any(String));
		const rendered = nextRender();
		host.send({ type: "message_start", entryId: "answer", message: { ...assistant, content: [] } });
		await rendered;
		const delta = nextRender();
		host.send({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Streamed answer" },
		});
		await delta;
		expect(view.render(80).join("\n")).toContain("Streamed answer");
		const permission = nextRender();
		host.send({
			type: "extension_ui_request",
			id: "permission",
			method: "select",
			title: "Allow operation?",
			options: ["Allow", "Deny"],
		});
		await permission;
		view.handleInput("\r");
		expect(await host.command("extension_ui_response")).toMatchObject({
			id: "permission",
			value: "Allow",
			answerId: expect.any(String),
			sessionId: "live",
		});
		expect(host.commands.find((record) => record.type === "set_client_info")?.capabilities).toContain(
			"interactive_user",
		);
		expect(host.commands.find((record) => record.type === "subscribe_sessions")).toMatchObject({
			mirror: "all",
			sessions: { ids: ["live"] },
		});
		await view.close();
		expect(host.commands.filter((record) => record.type === "release_attachment")).toHaveLength(1);
		expect(
			host.commands.some((record) =>
				["open_session", "close_session", "release_session"].includes(String(record.type)),
			),
		).toBe(false);
	});

	it("keeps the last transcript and state on disconnect", async () => {
		const { host, view, nextRender } = await attached();
		const state = view.state;
		const disconnected = nextRender();
		host.disconnect();
		await disconnected;
		expect(view.state).toBe(state);
		expect(view.render(80).join("\n")).toContain("Disconnected");
		expect(view.render(80).join("\n")).toContain("Previous question");
		expect(host.commands.some((record) => record.type === "open_session")).toBe(false);
	});

	it("replaces coalesced partial snapshots and renders the final message once", async () => {
		const { host, view, nextRender } = await attached();
		const partial = nextRender();
		host.send({
			type: "message_update",
			message: assistant,
			usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" },
		});
		await partial;
		expect(view.render(80).join("\n")).toContain("Streamed answer");
		const end = nextRender();
		host.send({ type: "message_end", entryId: "answer", message: assistant });
		await end;
		expect(view.render(80).join("\n").split("Streamed answer")).toHaveLength(2);
	});

	it("answers a question using the real question keyboard component", async () => {
		const { host, view, nextRender } = await attached();
		const question = nextRender();
		host.send({
			type: "extension_ui_request",
			id: "question-ui",
			method: "question",
			requestId: "question",
			toolCallId: "ask",
			waitForAnswer: true,
			questions: [
				{
					id: "q",
					header: "Choice",
					question: "Choose a path",
					options: [{ label: "First" }, { label: "Second" }],
					multiSelect: false,
				},
			],
			timeout: 60000,
			remainingMs: 60000,
			askedAtMs: Date.now(),
			deadlineAtMs: Date.now() + 60000,
		});
		await question;
		view.handleInput("2");
		expect(await host.command("extension_ui_response")).toMatchObject({
			id: "question-ui",
			answers: { q: { selected: ["Second"] } },
			answerId: expect.any(String),
		});
	});

	it("routes steering and Stop without closing the session", async () => {
		const { host, view } = await attached();
		await view.submit("/steer Change direction");
		await view.abort();
		expect(await host.command("steer")).toMatchObject({
			message: "Change direction",
			sessionId: "live",
			clientMessageId: expect.any(String),
		});
		expect(await host.command("abort")).toMatchObject({
			intent: "stop",
			sessionId: "live",
			effectId: expect.any(String),
		});
		expect(host.commands.some((record) => record.type === "close_session")).toBe(false);
	});

	it("pages older history without repeating entries and fits narrow terminals", async () => {
		const { host, view } = await attached();
		await view.loadHistory();
		expect(host.commands.filter((record) => record.type === "get_entries")[1]).toMatchObject({
			before: "history",
			tail: 100,
		});
		expect(view.render(80).join("\n").split("Previous question")).toHaveLength(2);
		expect(view.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
	});

	it("uses a named pipe for the scripted endpoint on Windows", async () => {
		const { host, view } = await attached();
		if (process.platform === "win32")
			expect(resolveSocketTransportAddress(host.path, "win32")).toMatch(/^\\\\\.\\pipe\\/);
		await view.submit("Pipe or socket");
		expect(await host.command("prompt")).toMatchObject({ message: "Pipe or socket" });
	});

	it("refuses non-interactive terminals before opening a connection", () => {
		expect(() => validateAttachTerminal(false, true)).toThrow(/interactive terminal/i);
		expect(() => validateAttachTerminal(true, false)).toThrow(/interactive terminal/i);
	});

	it("rejects --attach with --mode rpc as usage", () => {
		const parsed = parseArgs(["--attach", "/tmp/x.sock", "--mode", "rpc"]);
		expect(parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")).toBe(true);
	});
	// #4269 review M1: an endpoint's bad record or a dead socket never throws into the terminal's input path.
	it("reports an unreadable endpoint record and disconnects instead of throwing", async () => {
		const { host, until, screen } = await attached();
		host.sendRaw("{not json");
		await until((text) => text.includes("Disconnected"));
		expect(screen()).toContain("unreadable record");
		expect(screen()).toContain("Previous question");
	});

	it("rejects an answer on a dead connection instead of throwing", async () => {
		const client = new AttachClient(
			() => {},
			() => {},
		);
		let sent: Promise<void> | undefined;
		expect(() => {
			sent = client.answer("live", { type: "extension_ui_response", id: "permission", value: "Allow" });
		}).not.toThrow();
		await expect(sent).rejects.toThrow(/Disconnected/);
	});

	// #4269 review M3: a dialog leaves the screen only when the endpoint accepted its answer.
	it.each(["grant_answer_refused", "question_incomplete"])(
		"re-shows a dialog whose answer the endpoint refuses with %s",
		async (refusal) => {
			const { host, view, until } = await attached({ answer: () => ({ error: refusal }) });
			host.send(permissionRequest);
			await until((text) => text.includes("Allow operation?"));
			view.handleInput("\r");
			await host.command("extension_ui_response");
			await until((text) => text.includes(refusal) && text.includes("Allow operation?"));
			view.handleInput("\r");
			const first = host.commands.find((record) => record.type === "extension_ui_response");
			await host.waitFor((record) => record.type === "extension_ui_response" && record !== first);
			// The second answer is refused too, so the dialog comes back again.
			await until((text) => text.includes("Allow operation?"));
		},
	);

	it("re-shows a dialog when the endpoint never acknowledges its answer", async () => {
		const { host, view, until } = await attached({ answer: () => "none" }, 50);
		host.send(permissionRequest);
		await until((text) => text.includes("Allow operation?"));
		view.handleInput("\r");
		await host.command("extension_ui_response");
		await until((text) => text.includes("No acknowledgement") && text.includes("Allow operation?"));
	});

	it.each(["question_already_resolved", "unknown_extension_ui_request"])(
		"dismisses a dialog the endpoint no longer waits on (%s) and says so",
		async (refusal) => {
			const { host, view, until, screen } = await attached({ answer: () => ({ error: refusal }) });
			host.send(permissionRequest);
			await until((text) => text.includes("Allow operation?"));
			view.handleInput("\r");
			await until((text) => text.includes(refusal));
			expect(screen()).not.toContain("Allow operation?");
		},
	);

	it("keeps typed text when the endpoint refuses a prompt", async () => {
		const { view, until, screen } = await attached({ refuse: { prompt: "session_busy" } });
		for (const key of "Keep this text") view.handleInput(key);
		view.handleInput("\r");
		await until((text) => text.includes("session_busy"));
		expect(screen()).toContain("Keep this text");
	});

	it("sends a width update when the terminal width changes", async () => {
		const { host, view } = await attached();
		view.render(60);
		const update = await host.waitFor((record) => record.type === "set_client_info" && record.width === 60);
		expect(update).not.toHaveProperty("capabilities");
	});
});
