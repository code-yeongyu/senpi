import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage, type QueuedInputPort, type StreamFn } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function texts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
	});
}

function recordingStream(log: string[], onRequest?: () => void): StreamFn {
	return (_model, context) => {
		log.push(`request:${texts(context.messages).join("|")}`);
		onRequest?.();
		const stream = new MockAssistantStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant("done") }));
		return stream;
	};
}

function loggingPort(log: string[], commit?: () => Promise<void>): QueuedInputPort {
	return {
		claim: async (queue, drain) => {
			const messages = drain();
			if (messages.length > 0) log.push(`claim:${queue}:${texts(messages).join("|")}`);
			return messages;
		},
		release: async (queue, messages, giveBack) => {
			log.push(`release:${queue}:${texts(messages).join("|")}`);
			giveBack.restore();
		},
		commitConsumption: async (queue, messages) => {
			log.push(`commit:${queue}:${texts(messages).join("|")}`);
			await commit?.();
		},
	};
}

describe("Agent queuedInputPort (senpi#3549)", () => {
	it("commits a follow-up's consumption before the provider request that carries it", async () => {
		const log: string[] = [];
		const agent = new Agent({
			streamFn: recordingStream(log),
			queuedInputPort: loggingPort(log),
		});
		agent.followUp(user("later"));

		await agent.prompt("first");

		expect(log).toEqual(["request:first", "claim:followUp:later", "commit:followUp:later", "request:first|later"]);
	});

	it("reports a steering drain as the steering queue", async () => {
		const log: string[] = [];
		// oxlint-disable-next-line eslint/prefer-const -- a closure reads it; const would throw in the TDZ if that closure ran before the assignment, so the rewrite is reviewed separately
		let agent: Agent | undefined;
		agent = new Agent({
			streamFn: recordingStream(log, () => {
				if (log.length === 1) agent?.steer(user("steer"));
			}),
			queuedInputPort: loggingPort(log),
		});

		await agent.prompt("first");

		expect(log).toEqual(["request:first", "claim:steering:steer", "commit:steering:steer", "request:first|steer"]);
	});

	it("keeps a message out of every request and back in its queue when the commit rejects", async () => {
		const log: string[] = [];
		const agent = new Agent({
			streamFn: recordingStream(log),
			queuedInputPort: loggingPort(log, async () => {
				throw new Error("journal unavailable");
			}),
		});
		agent.followUp(user("later"));

		await agent.prompt("first").catch(() => undefined);

		expect(log).toEqual(["request:first", "claim:followUp:later", "commit:followUp:later", "release:followUp:later"]);
		expect(texts(agent.state.messages)).toEqual(["first"]);
		expect(texts(agent.peekQueuedMessages())).toEqual(["later"]);
	});

	it("marks a run that failed in the port as a local failure, not a provider one (senpi#3866)", async () => {
		const log: string[] = [];
		const agent = new Agent({
			streamFn: recordingStream(log),
			queuedInputPort: loggingPort(log, async () => {
				throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
			}),
		});
		agent.followUp(user("later"));

		await agent.prompt("first");

		const failure = agent.state.messages.at(-1);
		expect(failure?.role === "assistant" && failure.stopReason).toBe("error");
		expect(failure?.role === "assistant" && failure.failureSource).toBe("local");
	});

	it("leaves a failure thrown by the stream unmarked", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("socket hang up");
			},
			queuedInputPort: loggingPort([]),
		});

		await agent.prompt("first");

		const failure = agent.state.messages.at(-1);
		expect(failure?.role === "assistant" && failure.stopReason).toBe("error");
		expect(failure?.role === "assistant" && failure.failureSource).toBeUndefined();
	});

	it.each([
		{ queue: "steering" as const, enqueue: (agent: Agent) => agent.steer(user("queued")) },
		{ queue: "followUp" as const, enqueue: (agent: Agent) => agent.followUp(user("queued")) },
	])("claims and commits a $queue run started from the queue before its request", async ({ queue, enqueue }) => {
		const log: string[] = [];
		const agent = new Agent({
			initialState: { messages: [user("first"), assistant("done")] },
			streamFn: recordingStream(log),
			queuedInputPort: loggingPort(log),
		});
		enqueue(agent);

		await agent.continue();

		expect(log).toEqual([`claim:${queue}:queued`, `commit:${queue}:queued`, "request:first|queued"]);
	});

	it("starts no request and keeps the input queued when a queue-started run cannot commit", async () => {
		const log: string[] = [];
		const agent = new Agent({
			initialState: { messages: [user("first"), assistant("done")] },
			streamFn: recordingStream(log),
			queuedInputPort: loggingPort(log, async () => {
				throw new Error("journal unavailable");
			}),
		});
		agent.followUp(user("queued"));

		await agent.continue();

		expect(agent.state.errorMessage).toContain("journal unavailable");
		expect(log).toEqual(["claim:followUp:queued", "commit:followUp:queued", "release:followUp:queued"]);
		expect(texts(agent.peekQueuedMessages())).toEqual(["queued"]);
	});

	it("claims and commits the queue a finished run drains after agent_end", async () => {
		const log: string[] = [];
		const agent = new Agent({ streamFn: recordingStream(log), queuedInputPort: loggingPort(log) });
		let queuedAtEnd = false;
		agent.subscribe((event) => {
			if (event.type !== "agent_end" || queuedAtEnd) return;
			queuedAtEnd = true;
			log.push("agent_end");
			agent.followUp(user("after"));
		});

		await agent.prompt("first");

		expect(log).toEqual([
			"request:first",
			"agent_end",
			"claim:followUp:after",
			"commit:followUp:after",
			"request:first|after",
		]);
	});

	it("tells the port its give-back was refused when a clear landed after the claim", async () => {
		const log: string[] = [];
		let agent: Agent | undefined;
		const port = loggingPort(log, async () => {
			agent?.clearAllQueues();
			throw new Error("journal unavailable");
		});
		port.release = async (queue, messages, giveBack) => {
			log.push(`release:${queue}:${texts(messages).join("|")}:restored=${giveBack.restore()}`);
		};
		agent = new Agent({ streamFn: recordingStream(log), queuedInputPort: port });
		agent.followUp(user("later"));

		await agent.prompt("first").catch(() => undefined);

		expect(log).toContain("release:followUp:later:restored=false");
		expect(texts(agent.peekQueuedMessages())).toEqual([]);
	});

	// senpi#3586 review H1-residual: the exits that take the queue outside the loop share the loop's give-back,
	// so a clear that lands while their commit runs keeps the input out on every one of them.
	describe("a clear during a failed commit keeps the input out on every queue exit", () => {
		function clearingPort(log: string[], agent: () => Agent): QueuedInputPort {
			const port = loggingPort(log, async () => {
				agent().clearAllQueues();
				throw new Error("journal unavailable");
			});
			port.release = async (queue, messages, giveBack) => {
				log.push(`release:${queue}:${texts(messages).join("|")}:restorable=${giveBack.restorable()}`);
				log.push(`restored=${giveBack.restore()}`);
			};
			return port;
		}

		it("continue() after an assistant message", async () => {
			const log: string[] = [];
			// oxlint-disable-next-line eslint/prefer-const -- a closure reads it; const would throw in the TDZ if that closure ran before the assignment, so the rewrite is reviewed separately
			let agent: Agent | undefined;
			agent = new Agent({
				initialState: { messages: [user("first"), assistant("done")] },
				streamFn: recordingStream(log),
				queuedInputPort: clearingPort(log, () => agent as Agent),
			});
			agent.followUp(user("queued"));

			await agent.continue();

			expect(log).toContain("release:followUp:queued:restorable=false");
			expect(log).toContain("restored=false");
			expect(texts(agent.peekQueuedMessages())).toEqual([]);
		});

		it("continueWithQueuedMessages()", async () => {
			const log: string[] = [];
			// oxlint-disable-next-line eslint/prefer-const -- a closure reads it; const would throw in the TDZ if that closure ran before the assignment, so the rewrite is reviewed separately
			let agent: Agent | undefined;
			agent = new Agent({
				initialState: { messages: [user("first")] },
				streamFn: recordingStream(log),
				queuedInputPort: clearingPort(log, () => agent as Agent),
			});
			agent.steer(user("queued"));

			await agent.continueWithQueuedMessages().catch(() => undefined);

			expect(log).toContain("release:steering:queued:restorable=false");
			expect(log).toContain("restored=false");
			expect(texts(agent.peekQueuedMessages())).toEqual([]);
		});

		it("the drain after agent_end", async () => {
			const log: string[] = [];
			// oxlint-disable-next-line eslint/prefer-const -- a closure reads it; const would throw in the TDZ if that closure ran before the assignment, so the rewrite is reviewed separately
			let agent: Agent | undefined;
			agent = new Agent({
				streamFn: recordingStream(log),
				queuedInputPort: clearingPort(log, () => agent as Agent),
			});
			let queuedAtEnd = false;
			agent.subscribe((event) => {
				if (event.type !== "agent_end" || queuedAtEnd) return;
				queuedAtEnd = true;
				agent?.followUp(user("after"));
			});

			await agent.prompt("first").catch(() => undefined);
			await agent.waitForIdle();

			expect(log).toContain("release:followUp:after:restorable=false");
			expect(log).toContain("restored=false");
			expect(texts(agent.peekQueuedMessages())).toEqual([]);
		});
	});

	it("leaves the standalone queue behavior unchanged without a port", async () => {
		const log: string[] = [];
		const agent = new Agent({ streamFn: recordingStream(log) });
		agent.followUp(user("later"));

		await agent.prompt("first");

		expect(log).toEqual(["request:first", "request:first|later"]);
	});
});
