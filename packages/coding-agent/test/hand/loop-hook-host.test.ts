// S33 (brain/hand split, C8.a; decisions C8, K7): when the loop runs away from the user's machine (an in-process
// stand-in for a hosted loop host), the user's loop hooks and shell hooks run on the user's machine (a hand runtime,
// bound to the loop session's id for that call only), their result is in the provider request, and while that machine is offline no provider request leaves; reconnecting resumes exactly once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createInProcessNetwork,
	createLoopHookHost,
	createReliableTransport,
	type LoopHookHost,
	localEndpoint,
	serveLoopHooks,
	type TransportSide,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type {
	BeforeAgentStartEventResult,
	ExtensionFactory,
	InputEventResult,
} from "../../src/core/extensions/types.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { createLoopHookCall } from "../../src/modes/rpc/loopless-tool-handlers.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";

const harnesses: Harness[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) close();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
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

/** A trusted project UserPromptSubmit shell hook that leaves a mark in its own cwd and adds context, or blocks the prompt. */
function writePromptHook(cwd: string, block = false): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const script = join(senpiDir, "prompt-hook.mjs");
	writeFileSync(
		script,
		"import { appendFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => { appendFileSync('hook-ran.txt', 'ran\\n'); " +
			(block
				? "process.stderr.write('blocked on the user machine'); process.exit(2); });"
				: "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'context from the user machine' } })); });"),
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

/** The hand's `input` reply, read as a session's input result plus what its hooks sent and reported. */
function parseInputReply(
	reply: unknown,
): HandReply & ({ action: "continue" | "handled" } | { action: "transform"; text: string }) {
	const value = reply as HandReply & { action?: unknown; text?: unknown };
	if (value.action === "transform" && typeof value.text === "string")
		return { ...value, action: "transform", text: value.text };
	if (value.action === "continue" || value.action === "handled") return { ...value, action: value.action };
	throw new Error(`unexpected input reply: ${JSON.stringify(reply)}`);
}

/** What the user's machine sends back for one loop-hook call: its result, plus what its hooks sent and reported. */
interface HandReply {
	sent?: {
		message: Parameters<ExtensionAPI["sendMessage"]>[0];
		options?: Parameters<ExtensionAPI["sendMessage"]>[1];
	}[];
	errors?: { extensionPath: string; error: string }[];
}

/**
 * The loop host's side: its `input` and `before_agent_start` wait for the user's machine and apply what its hooks
 * produced, through the loop session's own handling of those results, so the result is the same as a session's.
 */
const forwardLoopHooks =
	(host: LoopHookHost, workspace: string, issued: () => void, errors: string[]): ExtensionFactory =>
	(pi) => {
		const deliver = (reply: HandReply) => {
			for (const failed of reply.errors ?? []) errors.push(`${failed.extensionPath}: ${failed.error}`);
			for (const sent of reply.sent ?? []) pi.sendMessage(sent.message, sent.options);
		};
		const scopeOf = (sessionId: string) => ({ id: `session-${sessionId}`, root: workspace });
		pi.on("input", async (event, ctx): Promise<InputEventResult> => {
			issued();
			const sessionId = ctx.sessionManager.getSessionId();
			const reply = parseInputReply(
				await host.run("input", { text: event.text, sessionId, scope: scopeOf(sessionId) }),
			);
			deliver(reply);
			return reply.action === "transform" ? { action: "transform", text: reply.text } : { action: reply.action };
		});
		pi.on("before_agent_start", async (event, ctx): Promise<BeforeAgentStartEventResult> => {
			issued();
			const sessionId = ctx.sessionManager.getSessionId();
			const reply = (await host.run("before_agent_start", {
				prompt: event.prompt,
				systemPrompt: event.systemPrompt,
				sessionId,
				scope: scopeOf(sessionId),
			})) as HandReply & { messages?: NonNullable<BeforeAgentStartEventResult["message"]>[]; systemPrompt?: string };
			deliver(reply);
			const [message] = reply.messages ?? [];
			return {
				...(message === undefined ? {} : { message }),
				...(reply.systemPrompt === undefined ? {} : { systemPrompt: reply.systemPrompt }),
			};
		});
	};

/** The user machine is a hand: its scope runtime (default builtins, so the hooks builtin) runs the loop hooks. */
async function hostedSession(options: { block?: boolean; userExtension?: string } = {}) {
	const dirs = await handDirs("s33-c8");
	writePromptHook(dirs.cwd, options.block);
	const extension = join(dirs.cwd, "..", "user-ext.ts");
	if (options.userExtension !== undefined) writeFileSync(extension, options.userExtension);
	const machine = createLooplessHand(
		handConfiguration(dirs, options.userExtension === undefined ? [] : ["-e", extension]),
		{ twoSidedHome: "hand" },
	);
	const link = hookLink();
	const hand = serveLoopHooks({
		transport: link.hand,
		lane: "loop-hooks",
		run: machine.loopHooks,
	});
	closers.push(() => hand.close());
	const host = createLoopHookHost({ transport: link.loop, lane: "loop-hooks" });
	const issued = Promise.withResolvers<void>();
	const hookErrors: string[] = [];
	const loop = await createHarness({
		extensionFactories: [forwardLoopHooks(host, dirs.cwd, () => issued.resolve(), hookErrors)],
	});
	harnesses.push(loop);
	loop.setResponses([fauxAssistantMessage("done")]);
	const marker = join(dirs.cwd, "hook-ran.txt");
	const marks = () => (existsSync(marker) ? readFileSync(marker, "utf-8") : "");
	const requestText = () => JSON.stringify(loop.faux.getCallLog().map((entry) => entry.context));
	return { loop, link, host, hookErrors, issued: issued.promise, marks, requestText };
}

describe("the user's loop hooks run on the user's machine when the loop runs elsewhere (S33, C8.a)", () => {
	it("runs the user's shell hook on the user machine and puts its context in the provider request", async () => {
		const session = await hostedSession();

		await session.loop.session.prompt("ship it");

		expect(session.hookErrors).toEqual([]);
		expect(session.marks()).toBe("ran\n");
		expect(existsSync(join(session.loop.tempDir, "hook-ran.txt"))).toBe(false);
		expect(session.loop.faux.getCallLog()).toHaveLength(1);
		expect(session.requestText()).toContain("context from the user machine");
	});

	it("a blocking shell hook on the user machine stops the turn, with its notice in the transcript, as in a session", async () => {
		const session = await hostedSession({ block: true });

		await session.loop.session.prompt("ship it");

		expect(session.hookErrors).toEqual([]);
		expect(session.marks()).toBe("ran\n");
		expect(session.loop.faux.getCallLog()).toHaveLength(0);
		expect(JSON.stringify(session.loop.session.messages)).toContain('"decision":"block"');
	});

	it("an input transform on the user machine replaces the prompt before before_agent_start, as in a session", async () => {
		const session = await hostedSession({
			userExtension:
				'export default (pi) => { pi.on("input", (event) => ({ action: "transform", text: event.text + " (rewritten on the user machine)" })); };',
		});

		await session.loop.session.prompt("ship it");

		expect(session.hookErrors).toEqual([]);
		expect(session.loop.faux.getCallLog()).toHaveLength(1);
		expect(session.requestText()).toContain("ship it (rewritten on the user machine)");
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

		expect(session.hookErrors).toEqual([]);
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

describe("a loop-hook call's bound session (S33, option A)", () => {
	it("is the loop session's id, read-only, during the call only", async () => {
		const call = createLoopHookCall();
		let during: { id: string; file: string | undefined; idle: boolean } | undefined;
		let captured: ReturnType<typeof call.current>;

		await call.run("loop-session-1", "/work", async () => {
			captured = call.current();
			const facts = captured;
			if (facts === undefined) throw new Error("no facts inside the call");
			during = {
				id: facts.sessionManager.getSessionId(),
				file: facts.sessionManager.getSessionFile(),
				idle: facts.isIdle(),
			};
			expect(() => facts.sessionManager.getEntries()).toThrow(/loop-side/);
			expect(() => {
				(facts.sessionManager as unknown as Record<string, unknown>).getSessionId = () => "forged";
			}).toThrow(TypeError);
		});

		expect(during).toEqual({ id: "loop-session-1", file: undefined, idle: true });
		expect(call.current()).toBeUndefined();
		expect(() => captured?.sessionManager.getSessionId()).toThrow(/has ended/);
		expect(captured?.signal.aborted).toBe(true);
	});

	it("is not visible to work that runs outside the call", async () => {
		const call = createLoopHookCall();
		const outside = Promise.withResolvers<ReturnType<typeof call.current>>();

		await call.run("loop-session-2", "/work", async () => {});
		queueMicrotask(() => outside.resolve(call.current()));

		expect(await outside.promise).toBeUndefined();
	});
});

describe("a hand's loop-hook scopes (S33 review)", () => {
	const hookPayload = (id: string, root: string) => ({
		prompt: "p",
		systemPrompt: "s",
		sessionId: "loop-session",
		scope: { id, root },
	});

	it("refuses a scope bound to another root, a disposed scope, and every call after close", async () => {
		const dirs = await handDirs("s33-scope");
		const machine = createLooplessHand(handConfiguration(dirs), { twoSidedHome: "hand" });
		await machine.loopHooks("before_agent_start", hookPayload("a", dirs.cwd));

		await expect(
			machine.loopHooks("before_agent_start", hookPayload("a", join(dirs.cwd, "elsewhere"))),
		).rejects.toThrow(/scope_binding_mismatch/);
		const scope = await machine.openScope({ id: "b", root: dirs.cwd });
		await scope.dispose();
		await expect(machine.loopHooks("before_agent_start", hookPayload("b", dirs.cwd))).rejects.toThrow(/disposed/);
		await machine.close();
		await expect(machine.loopHooks("before_agent_start", hookPayload("a", dirs.cwd))).rejects.toThrow(/closed/);
	});

	it("reports only its own handlers' failures, not a concurrent tool call's", async () => {
		const dirs = await handDirs("s33-attrib");
		const extension = join(dirs.cwd, "..", "attrib-ext.ts");
		writeFileSync(
			extension,
			'export default (pi) => { pi.on("before_agent_start", async () => { globalThis.s33Entered(); await globalThis.s33Gate; }); pi.on("tool_result", () => { throw new Error("tool_result failed outside the hook call"); }); };',
		);
		writeFileSync(join(dirs.cwd, "a.txt"), "x");
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		Object.assign(globalThis, { s33Entered: entered.resolve, s33Gate: gate.promise });
		const machine = createLooplessHand(handConfiguration(dirs, ["-e", extension]), { twoSidedHome: "hand" });
		closers.push(() => void machine.close());

		const reply = machine.loopHooks("before_agent_start", hookPayload("s", dirs.cwd));
		await entered.promise;
		const scope = await machine.openScope({ id: "s", root: dirs.cwd });
		await scope.run({
			name: "read",
			toolCallId: "t1",
			arguments: { path: join(dirs.cwd, "a.txt") },
			signal: new AbortController().signal,
			nested: () => Promise.reject(new Error("this loop serves no planes")),
		});
		gate.resolve();

		expect(await reply).not.toHaveProperty("errors");
	});
});
