import { afterEach, describe, expect, it } from "vitest";
import type { CreateAgentSessionOptions } from "../../src/core/sdk.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { ThreadSettings as GeneratedThreadSettings } from "../../src/modes/app-server/protocol/generated/v2/ThreadSettings.ts";
import type { RouterNotification } from "../../src/modes/app-server/server/notifications.ts";
import {
	cleanupRoots,
	createHarness,
	FakeConnection,
	objectAt,
	responseResult,
	threadIdFromResponse,
} from "./app-server-thread-handlers-harness.ts";
import { createHarness as createSessionHarness, type Harness } from "./harness.ts";

const sessionHarnesses: Harness[] = [];

afterEach(async () => {
	while (sessionHarnesses.length > 0) sessionHarnesses.pop()?.cleanup();
	await cleanupRoots();
});

describe("app-server thread settings handlers", () => {
	it("applies model and effort, rejects other fields, and emits a valid subscriber-only snapshot", async () => {
		const sessionHarness = await createSessionHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		sessionHarnesses.push(sessionHarness);
		const harness = await createHarness({
			createSession: (options: CreateAgentSessionOptions) =>
				createAgentSession({
					...options,
					modelRegistry: sessionHarness.session.modelRegistry,
					model: sessionHarness.getModel("faux-1"),
				}),
		});
		const nonSubscriber = new FakeConnection("conn-2");
		const stableSubscriber = new FakeConnection("conn-3");
		stableSubscriber.capabilities.experimentalApi = false;
		harness.notifications.addConnection(nonSubscriber);
		harness.notifications.addConnection(stableSubscriber);
		const threadId = threadIdFromResponse(
			await harness.registry.dispatch(harness.connection, {
				id: 1,
				method: "thread/start",
				params: { cwd: harness.root, model: "faux-1", modelProvider: "faux" },
			}),
		);
		harness.notifications.subscribe(threadId, stableSubscriber.id);
		harness.connection.received.length = 0;
		nonSubscriber.received.length = 0;
		stableSubscriber.received.length = 0;

		const changed = await harness.registry.dispatch(harness.connection, {
			id: 2,
			method: "thread/settings/update",
			params: { threadId, model: "faux-2", effort: "high" },
		});
		const settingsNotification = onlyNotification(harness.connection.received, "thread/settings/updated");
		const settings = generatedSettings(settingsNotification);
		expect(responseResult(changed)).toEqual({});
		expect(settings.model).toBe("faux-2");
		expect(settings.effort).toBe("high");
		expect(settings.cwd).toBe(harness.root);
		expect(settings.approvalPolicy).toBe("never");
		expect(settings.approvalsReviewer).toBe("user");
		expect(settings.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
		expect(nonSubscriber.received).toEqual([]);
		expect(stableSubscriber.received).toEqual([]);

		const unsupported = await harness.registry.dispatch(harness.connection, {
			id: 3,
			method: "thread/settings/update",
			params: { threadId, cwd: harness.root, personality: null },
		});
		expect(unsupported).toEqual({
			id: 3,
			error: { code: -32600, message: "unsupported thread settings: cwd, personality" },
		});
	});

	it("accepts null model and effort as no-overrides", async () => {
		const harness = await createHarness();
		const threadId = threadIdFromResponse(
			await harness.registry.dispatch(harness.connection, {
				id: 4,
				method: "thread/start",
				params: { cwd: harness.root },
			}),
		);
		const entry = harness.threads.getLoadedThread(threadId);
		const initialModel = entry.session.model;
		const initialEffort = entry.session.thinkingLevel;
		harness.connection.received.length = 0;

		// Explicit null has the same no-override meaning as an omitted optional field.
		expect(
			responseResult(
				await harness.registry.dispatch(harness.connection, {
					id: 5,
					method: "thread/settings/update",
					params: { threadId, model: null },
				}),
			),
		).toEqual({});
		expect(
			responseResult(
				await harness.registry.dispatch(harness.connection, {
					id: 6,
					method: "thread/settings/update",
					params: { threadId, effort: null },
				}),
			),
		).toEqual({});
		expect(entry.session.model).toBe(initialModel);
		expect(entry.session.thinkingLevel).toBe(initialEffort);
		expect(harness.connection.received).toEqual([]);
	});

	it("gates the request and suppresses notifications for a no-op", async () => {
		const harness = await createHarness();
		const threadId = threadIdFromResponse(
			await harness.registry.dispatch(harness.connection, {
				id: 7,
				method: "thread/start",
				params: { cwd: harness.root },
			}),
		);
		harness.connection.received.length = 0;
		const noOp = await harness.registry.dispatch(harness.connection, {
			id: 8,
			method: "thread/settings/update",
			params: { threadId, effort: "off" },
		});
		expect(responseResult(noOp)).toEqual({});
		expect(harness.connection.received).toEqual([]);

		const stable = new FakeConnection("stable");
		stable.capabilities.experimentalApi = false;
		const stableResponse = await harness.registry.dispatch(stable, {
			id: 9,
			method: "thread/settings/update",
			params: { threadId, effort: "high" },
		});
		expect(stableResponse).toEqual({
			id: 9,
			error: { code: -32600, message: "thread/settings/update requires experimentalApi capability" },
		});
	});
});

function onlyNotification(notifications: readonly RouterNotification[], method: string): RouterNotification {
	const notification = notifications.find((candidate) => candidate.method === method);
	if (!notification) throw new Error(`missing notification ${method}`);
	return notification;
}

function generatedSettings(notification: RouterNotification): GeneratedThreadSettings {
	const value = objectAt(notification.params, "threadSettings");
	const effort = value.effort;
	const settings = {
		cwd: stringValue(value.cwd),
		approvalPolicy: "never",
		approvalsReviewer: "user",
		sandboxPolicy: { type: "dangerFullAccess" },
		activePermissionProfile: null,
		model: stringValue(value.model),
		modelProvider: stringValue(value.modelProvider),
		serviceTier: null,
		effort: typeof effort === "string" ? effort : null,
		summary: null,
		collaborationMode: {
			mode: "default",
			settings: { model: "unknown", reasoning_effort: "off", developer_instructions: null },
		},
		personality: null,
	} satisfies GeneratedThreadSettings;
	return settings;
}

function stringValue(value: unknown): string {
	if (typeof value !== "string") throw new Error("expected string");
	return value;
}
