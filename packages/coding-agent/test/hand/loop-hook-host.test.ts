// S33 (brain/hand split, C8.a; decisions C8, K7): when the loop runs away from the user's machine (an in-process
// stand-in for a hosted loop host), the user's loop hooks and shell hooks run on the user's machine, their result is in
// the provider request, and while that machine is offline no provider request leaves; reconnecting resumes exactly once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createInProcessNetwork,
	createLoopHookHost,
	createReliableTransport,
	type LoopHookHost,
	type LoopHookRunner,
	localEndpoint,
	serveLoopHooks,
	type TransportSide,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { BeforeAgentStartEventResult, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function side(): TransportSide {
	return createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => {
			throw error;
		},
	});
}

/** The link between the loop host and the user's machine, which the test can take down and bring back. */
function hookLink() {
	const network = createInProcessNetwork();
	const endpoint = localEndpoint("linux", `user-machine-${crypto.randomUUID()}`, "/tmp");
	const loop = side();
	const hand = side();
	const stop = network.listen(endpoint, hand);
	const link = network.dial(endpoint, loop);
	link.connect();
	closers.push(() => {
		link.drop();
		stop();
	});
	return { loop, hand, drop: () => link.drop(), connect: () => link.connect() };
}

const hooksFactory = (): ExtensionFactory => {
	const hooks = builtinExtensions.find((entry) => entry.id === "hooks");
	if (hooks === undefined) throw new Error("builtin hooks extension is not registered");
	return hooks.factory;
};

/** A trusted project UserPromptSubmit shell hook that leaves a mark in its own cwd and adds context. */
function writePromptHook(cwd: string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const script = join(senpiDir, "prompt-hook.mjs");
	writeFileSync(
		script,
		"import { appendFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => { appendFileSync('hook-ran.txt', 'ran\\n'); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'context from the user machine' } })); });",
	);
	const hookConfig = {
		hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] },
	};
	const sourcePath = join(senpiDir, "hooks.json");
	writeFileSync(sourcePath, JSON.stringify(hookConfig));
	const source = {
		discoveredAt: "pre-session",
		displayOrder: 0,
		scope: "project",
		sourcePath,
	} satisfies HookSourceMetadata;
	const hooks: Record<string, HookTrustEntry> = {};
	for (const handler of parseHookConfig(hookConfig, source).executableHandlers)
		hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: process.platform,
			updatedAt: "2026-11-04T00:00:00.000Z",
		});
	writeFileSync(join(senpiDir, "hooks-state.json"), JSON.stringify({ version: 1, hooks }));
}

/** The user's machine: its own runner runs the user's input and before_agent_start hooks for the loop host. */
const runUserHooks =
	(runner: ExtensionRunner, cwd: string): LoopHookRunner =>
	async (event, payload) => {
		if (event !== "before_agent_start") throw new Error(`no loop hooks for ${event}`);
		const { prompt, systemPrompt } = payload as { prompt: string; systemPrompt: string };
		await runner.emitInput(prompt, undefined, "interactive");
		const combined = await runner.emitBeforeAgentStart(prompt, undefined, systemPrompt, { cwd });
		return JSON.parse(JSON.stringify(combined ?? {})) as JsonValue;
	};

/** The loop host's side: its before_agent_start waits for the user's machine and applies what its hooks produced. */
const forwardLoopHooks =
	(host: LoopHookHost, issued: () => void): ExtensionFactory =>
	(pi) => {
		pi.on("before_agent_start", async (event): Promise<BeforeAgentStartEventResult> => {
			issued();
			const reply = (await host.run("before_agent_start", {
				prompt: event.prompt,
				systemPrompt: event.systemPrompt,
			})) as {
				messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
				systemPrompt?: string;
			};
			const [message] = reply.messages ?? [];
			return {
				...(message === undefined ? {} : { message }),
				...(reply.systemPrompt === undefined ? {} : { systemPrompt: reply.systemPrompt }),
			};
		});
	};

async function hostedSession() {
	const user = await createHarness({ extensionFactories: [{ factory: hooksFactory(), path: "<builtin:hooks>" }] });
	harnesses.push(user);
	writePromptHook(user.tempDir);
	const link = hookLink();
	const hand = serveLoopHooks({
		transport: link.hand,
		lane: "loop-hooks",
		run: runUserHooks(user.getExtensionRunner(), user.tempDir),
	});
	closers.push(() => hand.close());
	const host = createLoopHookHost({ transport: link.loop, lane: "loop-hooks" });
	const issued = Promise.withResolvers<void>();
	const loop = await createHarness({ extensionFactories: [forwardLoopHooks(host, () => issued.resolve())] });
	harnesses.push(loop);
	loop.setResponses([fauxAssistantMessage("done")]);
	const marks = () =>
		existsSync(join(user.tempDir, "hook-ran.txt")) ? readFileSync(join(user.tempDir, "hook-ran.txt"), "utf-8") : "";
	const requestText = () => JSON.stringify(loop.faux.getCallLog().map((entry) => entry.context));
	return { user, loop, link, host, issued: issued.promise, marks, requestText };
}

describe("the user's loop hooks run on the user's machine when the loop runs elsewhere (S33, C8.a)", () => {
	it("runs the user's shell hook on the user machine and puts its context in the provider request", async () => {
		const session = await hostedSession();

		await session.loop.session.prompt("ship it");

		expect(session.marks()).toBe("ran\n");
		expect(existsSync(join(session.loop.tempDir, "hook-ran.txt"))).toBe(false);
		expect(session.loop.faux.getCallLog()).toHaveLength(1);
		expect(session.requestText()).toContain("context from the user machine");
	});

	it("user machine offline: no provider request and the turn waits; reconnecting resumes it exactly once", async () => {
		const session = await hostedSession();
		session.link.drop();

		const turn = session.loop.session.prompt("ship it");
		await session.issued;

		expect(session.host.waiting()).toHaveLength(1);
		expect(session.loop.faux.getCallLog()).toHaveLength(0);
		expect(session.marks()).toBe("");

		session.link.connect();
		await turn;

		expect(session.marks()).toBe("ran\n");
		expect(session.loop.faux.getCallLog()).toHaveLength(1);
		expect(session.requestText()).toContain("context from the user machine");
		expect(session.host.waiting()).toEqual([]);
	});

	it("fused: the same shell hook runs in-process and no hook host is involved", async () => {
		const fused = await createHarness({ extensionFactories: [{ factory: hooksFactory(), path: "<builtin:hooks>" }] });
		harnesses.push(fused);
		writePromptHook(fused.tempDir);
		fused.setResponses([fauxAssistantMessage("done")]);

		await fused.session.prompt("ship it");

		expect(readFileSync(join(fused.tempDir, "hook-ran.txt"), "utf-8")).toBe("ran\n");
		expect(JSON.stringify(fused.faux.getCallLog().map((entry) => entry.context))).toContain(
			"context from the user machine",
		);
	});
});
