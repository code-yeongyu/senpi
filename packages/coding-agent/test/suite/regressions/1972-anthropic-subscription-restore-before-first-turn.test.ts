/**
 * senpi#1972: the Claude continuity binding is restored inside this provider's own
 * `session_start` handler, and the runner dispatches those handlers one after another in
 * registration order. A turn started from an EARLIER handler (terminal monitor restore,
 * goal continuation, loop run) reached admission before the restore ran, found no
 * binding and re-sent the whole conversation. Turns requested during that dispatch now
 * start only after every `session_start` handler has returned.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createEventBus } from "../../../src/core/event-bus.ts";
import {
	type ContinuityBinding,
	forgetBinding,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { admitRestoredBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-restored-admission.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionAPI,
	ExtensionContextActions,
	ExtensionFactory,
} from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	assistant,
	cleanupRestartFixture,
	context,
	emit,
	fakeExtension,
	residentEntry,
	SESSION_ID,
	sessionFixture,
} from "../../helpers/anthropic-subscription-restart-fixture.ts";
import { createInMemoryModelRegistry } from "../../model-runtime-test-utils.ts";

type Admission = { binding: ContinuityBinding | undefined };

/** Persist a real sidecar + marker for SESSION_ID, then drop every in-process trace of it. */
async function persistedSession() {
	const { sessionFile, branch } = sessionFixture();
	const writer = fakeExtension(branch);
	registerSessionRegistry(writer.api);
	residentEntry();
	await emit(
		writer.handlers,
		"message_end",
		{ type: "message_end", message: assistant() },
		context(sessionFile, branch),
	);
	branch.push({ type: "message", id: "assistant-entry", message: assistant() });
	closeSession(SESSION_ID, "process_exit");
	forgetBinding(SESSION_ID);
	return context(sessionFile, branch);
}

async function restartedRunner(restartContext: ReturnType<typeof context>, admissions: Promise<Admission>[]) {
	const startsTurnOnResume: ExtensionFactory = (pi) => {
		pi.on("session_start", () => {
			pi.sendMessage({ customType: "monitor-restore", content: "resume", display: false }, { triggerTurn: true });
		});
	};
	const provider: ExtensionFactory = (pi) => {
		const on = pi.on.bind(pi) as unknown as (event: string, handler: (payload: unknown) => unknown) => void;
		const onRestartContext = {
			on: (event: string, handler: (payload: unknown, ctx: unknown) => unknown) =>
				on(event, (payload) => handler(payload, restartContext)),
			appendEntry: pi.appendEntry,
		} as unknown as ExtensionAPI;
		registerSessionRegistry(onRestartContext);
	};
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions = [
		await loadExtensionFromFactory(startsTurnOnResume, process.cwd(), eventBus, runtime, "<inline:early>"),
		await loadExtensionFromFactory(provider, process.cwd(), eventBus, runtime, "<builtin:claude-sdk-oauth>"),
	];
	const runner = new ExtensionRunner(
		extensions,
		runtime,
		process.cwd(),
		SessionManager.inMemory(),
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	const startTurn = (): void => {
		// A provider turn is asynchronous: it yields before admission, like the real prompt path.
		admissions.push(Promise.resolve().then(() => admitRestoredBinding(SESSION_ID, undefined, "oauth-slots")));
	};
	runner.bindCore(
		{
			sendMessage: (_message, options) => {
				if (options?.triggerTurn) startTurn();
			},
			sendUserMessage: startTurn,
		} as Partial<ExtensionActions> as ExtensionActions,
		{} as ExtensionContextActions,
	);
	return runner;
}

afterEach(() => {
	cleanupRestartFixture();
});

describe("issue #1972: the first turn sees the restored binding whichever extension starts it", () => {
	it("admits a turn started by an earlier session_start handler only after the restore", async () => {
		const restartContext = await persistedSession();
		const admissions: Promise<Admission>[] = [];
		const runner = await restartedRunner(restartContext, admissions);

		await runner.emit({ type: "session_start", reason: "resume" });

		expect(admissions).toHaveLength(1);
		const [first] = await Promise.all(admissions);
		expect(first?.binding).toMatchObject({ senpiSessionId: SESSION_ID, lastAssistantUuid: "assistant-uuid-1" });
	});
});

describe("issue #1972 controls: only turns requested during session_start dispatch wait", () => {
	async function recordingRunner(factory: ExtensionFactory, log: string[]) {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime, "<inline>");
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		runner.bindCore(
			{
				sendMessage: (message, options) => log.push(`${message.customType}:${options?.triggerTurn === true}`),
				sendUserMessage: (content) => log.push(`user:${String(content)}`),
			} as Partial<ExtensionActions> as ExtensionActions,
			{} as ExtensionContextActions,
		);
		return runner;
	}

	it("delivers non-turn messages at once and held turns in request order after the handlers", async () => {
		const log: string[] = [];
		const runner = await recordingRunner((pi) => {
			pi.on("session_start", () => {
				pi.sendMessage({ customType: "turn", content: "", display: false }, { triggerTurn: true });
				pi.sendUserMessage("hello");
				pi.sendMessage({ customType: "notice", content: "", display: false });
				log.push("handler-returned");
			});
		}, log);

		await runner.emit({ type: "session_start", reason: "resume" });

		expect(log).toEqual(["notice:false", "handler-returned", "turn:true", "user:hello"]);
	});

	it("starts a turn requested from any other event immediately", async () => {
		const log: string[] = [];
		const runner = await recordingRunner((pi) => {
			pi.on("agent_end", () => {
				pi.sendMessage({ customType: "turn", content: "", display: false }, { triggerTurn: true });
				log.push("handler-returned");
			});
		}, log);

		await runner.emit({ type: "agent_end", messages: [] });

		expect(log).toEqual(["turn:true", "handler-returned"]);
	});
});
