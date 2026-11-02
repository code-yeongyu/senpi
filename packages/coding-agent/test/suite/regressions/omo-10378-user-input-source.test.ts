import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedClientInput } from "../../../src/core/client-message-identity.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { clientAdmissionRecordSchema } from "../../../src/modes/rpc/client-admission-record.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// omo#10378: an extension that rebuilds per-session trust state on resume must tell a typed user
// message from one an extension injected. The live `input` event carries that source; the persisted
// user entry must carry the same value, or a resumed session cannot replay it.

function persistedUserSources(harness: Harness): { text: string; inputSource: unknown }[] {
	return harness.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		return [{ text: getMessageText(entry.message), inputSource: entry.inputSource }];
	});
}

function waitTool(release: Promise<void>): AgentTool {
	return {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await release;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
}

describe("omo#10378 persisted user input source", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given a typed prompt with no source #when it runs #then the entry records interactive", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("typed by a person");

		expect(persistedUserSources(harness)).toEqual([{ text: "typed by a person", inputSource: "interactive" }]);
	});

	it("#given a stamped prompt #when it reaches the provider #then the context carries no inputSource while the entry keeps it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("typed by a person");

		const sent = harness.faux.getCallLog()[0]?.context.messages ?? [];
		expect(sent.filter((message) => message.role === "user")).toEqual([
			{ role: "user", content: [{ type: "text", text: "typed by a person" }], timestamp: expect.any(Number) },
		]);
		expect(persistedUserSources(harness)).toEqual([{ text: "typed by a person", inputSource: "interactive" }]);
	});

	it("#given a queued follow-up #when it is prepared for durable custody #then the prepared record carries the same source and survives the admission schema", async () => {
		let releaseTool: (() => void) | undefined;
		const harness = await createHarness({
			tools: [waitTool(new Promise<void>((resolve) => (releaseTool = resolve)))],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const prepared: PreparedClientInput[] = [];

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("rpc follow-up", undefined, {
			source: "rpc",
			onQueuedInput: (input) => prepared.push(input),
		});
		releaseTool?.();
		await run;
		await harness.session.agent.waitForIdle();

		expect(prepared.map((input) => input.source)).toEqual(["rpc"]);
		const stored = clientAdmissionRecordSchema.parse({
			clientMessageId: "c-1",
			durableSessionId: "s",
			fingerprint: "f",
			disposition: "queued",
			state: "queued",
			prepared: prepared[0],
		});
		expect(stored.state === "queued" ? stored.prepared.source : undefined).toBe("rpc");
	});

	it("#given a prompt that loses the start race and is queued as a steer #when it is handed to durable custody #then the prepared record keeps the prompt's source", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		const agent = harness.session.agent;
		const realPrompt = agent.prompt.bind(agent);
		let raced = false;
		agent.prompt = ((...args: Parameters<typeof agent.prompt>) => {
			if (raced) return realPrompt(...args);
			raced = true;
			return Promise.reject(
				new Error(
					"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
				),
			);
		}) as typeof agent.prompt;
		let handOff: ((input: PreparedClientInput) => void) | undefined;
		const handedOff = new Promise<PreparedClientInput>((resolve) => {
			handOff = resolve;
		});
		const deadline = new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error("waited 10s for the raced prompt's onQueuedInput, never fired")),
				10_000,
			).unref();
		});

		const run = harness.session.prompt("raced rpc prompt", {
			source: "rpc",
			onQueuedInput: (input) => handOff?.(input),
		});
		const prepared = await Promise.race([handedOff, deadline]);
		// The stubbed agent never starts the queued steer, so this prompt never settles; only its hand-off is asserted.
		void run.catch(() => undefined);

		expect(raced).toBe(true);
		expect({ text: prepared.text, source: prepared.source }).toEqual({ text: "raced rpc prompt", source: "rpc" });
	});

	it("#given input restored from durable custody #when it is delivered #then a recorded source is kept and a missing one stays unknown", async () => {
		let releaseTool: (() => void) | undefined;
		const harness = await createHarness({
			tools: [waitTool(new Promise<void>((resolve) => (releaseTool = resolve)))],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.restoreQueuedInput({
			text: "restored rpc",
			mode: "followUp",
			enqueueOrder: 100,
			source: "rpc",
		});
		await harness.session.restoreQueuedInput({ text: "restored legacy", mode: "followUp", enqueueOrder: 101 });
		releaseTool?.();
		await run;
		await harness.session.waitForSettledSessionWork();
		await harness.session.agent.waitForIdle();

		expect(persistedUserSources(harness).filter((entry) => entry.text.startsWith("restored"))).toEqual([
			{ text: "restored rpc", inputSource: "rpc" },
			{ text: "restored legacy", inputSource: undefined },
		]);
	});

	it("#given an rpc prompt #when it runs #then the entry records rpc", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("sent by a client", { source: "rpc" });

		expect(persistedUserSources(harness)).toEqual([{ text: "sent by a client", inputSource: "rpc" }]);
	});

	it("#given an extension sendUserMessage while idle #when it runs #then the entry records extension", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_end") {
					unsubscribe();
					resolve();
				}
			});
		});
		api?.sendUserMessage("injected by an extension");
		await settled;
		await harness.session.waitForSettledSessionWork();

		expect(persistedUserSources(harness)).toEqual([{ text: "injected by an extension", inputSource: "extension" }]);
	});

	it("#given queued steer and follow-up input #when the run drains them #then each entry keeps its own source", async () => {
		let api: ExtensionAPI | undefined;
		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after steer"),
			fauxAssistantMessage("after typed follow-up"),
			fauxAssistantMessage("after injected follow-up"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.steer("typed steer");
		await harness.session.followUp("typed follow-up");
		const injectedQueued = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "queue_update" && event.followUp.includes("injected follow-up")) {
					unsubscribe();
					resolve();
				}
			});
		});
		api?.sendUserMessage("injected follow-up", { deliverAs: "followUp" });
		await injectedQueued;
		releaseTool?.();
		await run;
		await harness.session.waitForSettledSessionWork();
		await harness.session.agent.waitForIdle();

		expect(persistedUserSources(harness)).toEqual([
			{ text: "start", inputSource: "interactive" },
			{ text: "typed steer", inputSource: "interactive" },
			{ text: "typed follow-up", inputSource: "interactive" },
			{ text: "injected follow-up", inputSource: "extension" },
		]);
	});
});
