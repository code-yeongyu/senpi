// senpi#3230: suggest a fresh session with a handoff when a large session's cache has expired.
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHandoffBrief } from "../../src/core/extensions/builtin/handoff-hint/brief.ts";
import { estimateHandoff, hintText } from "../../src/core/extensions/builtin/handoff-hint/estimate.ts";
import {
	createHandoffHintExtension,
	HANDOFF_BRIEF_MESSAGE_TYPE,
	HANDOFF_HINT_ENTRY_TYPE,
	HANDOFF_HINT_EVENT,
	HANDOFF_HINT_WIDGET_KEY,
	type HandoffHintEvent,
	KEEP_GOING_LABEL,
	START_FRESH_LABEL,
} from "../../src/core/extensions/builtin/handoff-hint/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

const opus: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

const TTL_MS = 300_000;

function assistant(prompt: number, toolCalls: Array<{ name: string; arguments: unknown }> = [], text = "done") {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((call, index) => ({ type: "toolCall", id: `t${index}`, ...call })),
		],
		usage: { input: 0, output: 10, cacheRead: prompt, cacheWrite: 0, totalTokens: prompt + 10, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageEntry(message: unknown, id: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-10-19T00:00:00Z", message } as SessionEntry;
}

type Handler = (event: any, ctx: any) => unknown;

function harness(
	options: {
		tokens?: number;
		kind?: "interactive" | "worker";
		mode?: string;
		settings?: object;
		goal?: "active";
		cancelSwitch?: boolean;
	} = {},
) {
	let now = 1_000_000;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const entries: SessionEntry[] = [
		messageEntry({ role: "user", content: "start", timestamp: 1 }, "u0"),
		messageEntry(assistant(94_000), "a0"),
	];
	const widgets: Array<{ key: string; lines: string[] | undefined; options: any }> = [];
	const events: HandoffHintEvent[] = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const newSessions: Array<{ parentSession?: string; sent: unknown[] }> = [];
	const notices: string[] = [];
	let tokens = options.tokens ?? 500_000;
	let idle = true;
	const pi = {
		sessionKind: options.kind ?? "interactive",
		sessionContext: {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data });
			entries.push({
				type: "custom",
				id: `c${appended.length}`,
				parentId: null,
				timestamp: "",
				customType,
				data,
			} as SessionEntry);
		},
		getSettings: () => ({ handoffHint: options.settings }),
		events: {
			emit: (channel: string, data: unknown) => {
				if (channel === HANDOFF_HINT_EVENT) events.push(data as HandoffHintEvent);
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
				return () => {};
			},
		},
	} as unknown as ExtensionAPI;
	createHandoffHintExtension({
		now: () => now,
		readGoal: async () => (options.goal === "active" ? ({ status: "active", objective: "ship it" } as never) : null),
	})(pi);
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		cwd: "/work",
		model: opus,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		isCompacting: () => false,
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionId: () => "s1",
			getSessionFile: () => "/sessions/s1.jsonl",
			getSessionDir: () => "/sessions",
			getFullBranch: () => entries,
		},
		ui: {
			setWidget: (key: string, lines: string[] | undefined, opts: unknown) =>
				widgets.push({ key, lines, options: opts }),
			notify: (message: string) => notices.push(message),
		},
		newSession: async (opts: { parentSession?: string; withSession?: (next: any) => Promise<void> }) => {
			if (options.cancelSwitch) return { cancelled: true };
			const record = { parentSession: opts.parentSession, sent: [] as unknown[] };
			newSessions.push(record);
			await opts.withSession?.({ sendMessage: async (message: unknown) => record.sent.push(message) });
			return { cancelled: false };
		},
	} as unknown as ExtensionContext & ExtensionCommandContext;
	async function fire(event: string, data: any = { type: event }) {
		for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
	}
	async function humanTurn(source = "interactive") {
		await fire("input", { type: "input", text: "do it", source });
		idle = false;
		await fire("agent_start");
		idle = true;
		await fire("agent_end", { type: "agent_end", messages: [] });
		await fire("agent_settled");
	}
	async function advance(ms: number) {
		now += ms;
		await vi.advanceTimersByTimeAsync(ms);
	}
	const visible = () => widgets.at(-1)?.key === HANDOFF_HINT_WIDGET_KEY && widgets.at(-1)?.lines !== undefined;
	return {
		fire,
		humanTurn,
		advance,
		visible,
		widgets,
		events,
		appended,
		entries,
		newSessions,
		notices,
		now: () => now,
		// Commands get their own context object, as `createCommandContext()` builds one per invocation.
		run: (args: string) => commands.get("handoff")!.handler(args, { ...ctx }),
		setTokens: (value: number) => (tokens = value),
		emitWarmPing: () => pi.events?.emit("cache_warm_ping", {}),
	};
}

describe("handoff hint", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("shows one line with both choices only after the cache has expired", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.humanTurn();
		await h.advance(TTL_MS - 1000);
		expect(h.visible()).toBe(false);
		await h.advance(1000);
		expect(h.visible()).toBe(true);
		const shown = h.widgets.at(-1)!;
		expect(shown.lines).toHaveLength(1);
		expect(shown.lines![0]).toMatch(/^The next reply would cost about \$2\.50; a fresh session about \$0\.47\./);
		expect(shown.options.actions).toEqual([
			{ label: START_FRESH_LABEL, command: "/handoff" },
			{ label: KEEP_GOING_LABEL, command: "/handoff keep" },
		]);
		expect(h.events.map((event) => event.action)).toEqual(["shown"]);
	});

	it("shows at most once per threshold crossing", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.humanTurn();
		await h.advance(TTL_MS);
		await h.humanTurn();
		await h.advance(TTL_MS);
		expect(h.events.map((event) => event.action)).toEqual(["shown"]);
		h.setTokens(150_000);
		await h.humanTurn();
		await h.advance(TTL_MS);
		h.setTokens(500_000);
		await h.humanTurn();
		await h.advance(TTL_MS);
		expect(h.events.map((event) => event.action)).toEqual(["shown", "shown"]);
	});

	it("never shows under the token floor, under the saving floor, or near the compaction trigger", async () => {
		for (const [tokens, settings] of [
			[150_000, undefined],
			[250_000, { minSavingUsd: 5 }],
			[850_000, undefined],
		] as const) {
			const h = harness({ tokens, settings });
			await h.fire("session_start");
			await h.humanTurn();
			await h.advance(TTL_MS * 2);
			expect(h.visible(), `tokens ${tokens}`).toBe(false);
		}
	});

	it("a warm ping pushes the expiry out", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.humanTurn();
		await h.advance(TTL_MS - 10_000);
		h.emitWarmPing();
		await h.advance(20_000);
		expect(h.visible()).toBe(false);
		await h.advance(TTL_MS);
		expect(h.visible()).toBe(true);
	});

	it("never shows for worker sessions, one-shot modes, unattended turns, or when disabled", async () => {
		const cases = [
			harness({ kind: "worker" }),
			harness({ mode: "print" }),
			harness({ settings: { enabled: false } }),
			harness({ goal: "active" }),
		];
		for (const h of cases) {
			await h.fire("session_start");
			await h.humanTurn();
		}
		const unattended = harness();
		await unattended.fire("session_start");
		await unattended.humanTurn("extension");
		cases.push(unattended);
		for (const h of cases) {
			await h.advance(TTL_MS * 2);
			expect(h.visible()).toBe(false);
			expect(h.events).toEqual([]);
		}
	});

	it("Keep going hides the hint and the dismissal sticks for the session, across a resume", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.humanTurn();
		await h.advance(TTL_MS);
		await h.run("keep");
		expect(h.visible()).toBe(false);
		expect(h.appended).toEqual([{ customType: HANDOFF_HINT_ENTRY_TYPE, data: { phase: "dismissed" } }]);
		h.setTokens(100_000);
		await h.humanTurn();
		h.setTokens(600_000);
		await h.humanTurn();
		await h.advance(TTL_MS * 2);
		await h.fire("session_start");
		await h.humanTurn();
		await h.advance(TTL_MS * 2);
		expect(h.events.map((event) => event.action)).toEqual(["shown", "dismissed"]);
	});

	it("a resumed session whose cache expired while it was closed shows the hint before the first reply", async () => {
		const h = harness();
		h.entries.push(messageEntry({ ...assistant(480_000), timestamp: h.now() - TTL_MS - 60_000 }, "a1"));
		await h.fire("session_start", { type: "session_start", reason: "resume" });
		await h.advance(0);
		expect(h.visible()).toBe(true);
		expect(h.events.map((event) => event.action)).toEqual(["shown"]);
	});

	it("a resumed session with a warm cache waits out the rest of the cache lifetime", async () => {
		const h = harness();
		h.entries.push(messageEntry({ ...assistant(480_000), timestamp: h.now() - 60_000 }, "a1"));
		await h.fire("session_start", { type: "session_start", reason: "resume" });
		await h.advance(TTL_MS - 60_000 - 1000);
		expect(h.visible()).toBe(false);
		await h.advance(1000);
		expect(h.visible()).toBe(true);
	});

	it("a cancelled switch counts no acceptance and keeps the hint", async () => {
		const h = harness({ cancelSwitch: true });
		await h.fire("session_start");
		await h.humanTurn();
		await h.advance(TTL_MS);
		await h.run("");
		expect(h.events.map((event) => event.action)).toEqual(["shown"]);
		expect(h.visible()).toBe(true);
	});

	it("an unknown argument explains the two choices and starts nothing", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.humanTurn();
		await h.advance(TTL_MS);
		await h.run("kep");
		expect(h.newSessions).toHaveLength(0);
		expect(h.appended).toEqual([]);
		expect(h.notices).toHaveLength(1);
		expect(h.visible()).toBe(true);
	});

	it("Start fresh opens a linked session seeded with the brief and starts no turn", async () => {
		const h = harness();
		await h.fire("session_start");
		await h.humanTurn();
		await h.advance(TTL_MS);
		await h.run("");
		expect(h.events.map((event) => event.action)).toEqual(["shown", "accepted"]);
		expect(h.newSessions).toHaveLength(1);
		expect(h.newSessions[0].parentSession).toBe("/sessions/s1.jsonl");
		const [brief] = h.newSessions[0].sent as Array<{ customType: string; content: string; display: boolean }>;
		expect(brief.customType).toBe(HANDOFF_BRIEF_MESSAGE_TYPE);
		expect(brief.display).toBe(true);
		expect(brief.content).toContain("/sessions/s1.jsonl");
	});
});

describe("handoff estimate and brief", () => {
	it("prices a cold resend from the model's cost card and says so in plain words", () => {
		const estimate = estimateHandoff(opus, 512_000, 94_000, Date.now())!;
		expect(estimate.nextReplyUsd).toBeCloseTo(2.56, 2);
		expect(estimate.freshUsd).toBeCloseTo(0.47, 2);
		expect(hintText(estimate, false)).toBe(
			"The next reply would cost about $2.56; a fresh session about $0.47. This session is 512k tokens and its cache has expired.",
		);
		expect(hintText(estimate, true)).toMatch(
			/^The next reply would cost about \$2\.56 at API prices; a fresh session about \$0\.47\./,
		);
		expect(
			estimateHandoff({ ...opus, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 512_000, 94_000, 0),
		).toBeUndefined();
	});

	it("builds the brief from session state alone: open todos, last ask and answer, touched files", () => {
		const entries = [
			messageEntry({ role: "user", content: "fix the parser", timestamp: 1 }, "u1"),
			messageEntry(
				assistant(300_000, [
					{ name: "read", arguments: { path: "src/parse.ts" } },
					{
						name: "apply_patch",
						arguments: { input: "*** Begin Patch\n*** Update File: src/lex.ts\n*** End Patch" },
					},
				]),
				"a1",
			),
			{
				type: "custom",
				id: "todo",
				parentId: null,
				timestamp: "",
				customType: "senpi.todo-state",
				data: {
					schema: "v2",
					phases: [
						{
							name: "Fix",
							tasks: [
								{ content: "Write test", status: "in_progress" },
								{ content: "Ship", status: "completed" },
							],
						},
					],
				},
			} as SessionEntry,
			messageEntry(assistant(310_000, [], "Parser fixed, test pending."), "a2"),
		];
		const brief = buildHandoffBrief({
			entries,
			goal: null,
			cwd: "/work",
			modelLabel: "anthropic/claude-opus-5-5",
			previousSessionFile: "/sessions/old.jsonl",
			contextTokens: 310_000,
		});
		expect(brief).toContain("/sessions/old.jsonl");
		expect(brief).toContain("- [in progress] Fix: Write test");
		expect(brief).not.toContain("Ship");
		expect(brief).toContain("Last request:\nfix the parser");
		expect(brief).toContain("Last answer:\nParser fixed, test pending.");
		expect(brief).toContain("- src/lex.ts\n- src/parse.ts");
	});

	it("caps the open todos so a long list cannot grow the brief without bound", () => {
		const tasks = Array.from({ length: 30 }, (_, index) => ({
			content: `task ${index} ${"x".repeat(400)}`,
			status: "pending",
		}));
		const brief = buildHandoffBrief({
			entries: [
				{
					type: "custom",
					id: "todo",
					parentId: null,
					timestamp: "",
					customType: "senpi.todo-state",
					data: { schema: "v2", phases: [{ name: "Work", tasks }] },
				} as SessionEntry,
			],
			goal: null,
			cwd: "/work",
			modelLabel: undefined,
			previousSessionFile: undefined,
			contextTokens: 300_000,
		});
		const todoLines = brief.split("\n").filter((line) => line.startsWith("- [open] Work: "));
		expect(todoLines).toHaveLength(20);
		expect(todoLines.every((line) => line.length <= "- [open] Work: ".length + 203)).toBe(true);
		expect(brief).toContain("- and 10 more");
	});
});
