import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CreateAgentSessionOptions } from "../../../src/core/sdk.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import {
	createHarnessForRoot,
	FakeConnection,
	objectAt,
	responseResult,
	threadIdFromResponse,
} from "../../suite/app-server-thread-handlers-harness.ts";
import { createHarness as createSessionHarness } from "../../suite/harness.ts";

const root = await mkdtemp(join("/tmp", "senpi-task15-settings-"));
const sessionHarness = await createSessionHarness({
	models: [
		{ id: "faux-1", name: "One", reasoning: true },
		{ id: "faux-2", name: "Two", reasoning: true },
	],
});

try {
	const firstModel = sessionHarness.getModel("faux-1");
	if (!firstModel) throw new Error("faux-1 model was not registered");
	const harness = createHarnessForRoot(root, {
		createSession: (options: CreateAgentSessionOptions) =>
			createAgentSession({
				...options,
				modelRegistry: sessionHarness.session.modelRegistry,
				model: firstModel,
			}),
	});
	const nonSubscriber = new FakeConnection("task15-non-subscriber");
	const stableSubscriber = new FakeConnection("task15-stable-subscriber");
	stableSubscriber.capabilities.experimentalApi = false;
	harness.notifications.addConnection(nonSubscriber);
	harness.notifications.addConnection(stableSubscriber);

	const threadId = threadIdFromResponse(
		await harness.registry.dispatch(harness.connection, {
			id: 1,
			method: "thread/start",
			params: { cwd: root },
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
	const entry = harness.threads.getLoadedThread(threadId);
	const changedNotification = harness.connection.received.find(
		(notification) => notification.method === "thread/settings/updated",
	);
	const changedSettings = changedNotification ? objectAt(changedNotification.params, "threadSettings") : {};
	const modelApplied =
		responseResult(changed).model === undefined &&
		entry.session.model?.id === "faux-2" &&
		entry.session.thinkingLevel === "high" &&
		changedSettings.model === "faux-2" &&
		changedSettings.effort === "high"
			? 1
			: 0;
	const notificationOnChange =
		harness.connection.received.length === 1 &&
		nonSubscriber.received.length === 0 &&
		stableSubscriber.received.length === 0
			? 1
			: 0;

	harness.connection.received.length = 0;
	const noOp = await harness.registry.dispatch(harness.connection, {
		id: 3,
		method: "thread/settings/update",
		params: { threadId, effort: "high" },
	});
	const notificationOnNoop =
		responseResult(noOp).model === undefined && harness.connection.received.length === 0 ? 0 : 1;

	const unsupported = await harness.registry.dispatch(harness.connection, {
		id: 4,
		method: "thread/settings/update",
		params: { threadId, cwd: root, personality: null },
	});
	const unsupportedRejected =
		"error" in unsupported &&
		unsupported.error.code === -32600 &&
		unsupported.error.message === "unsupported thread settings: cwd, personality"
			? 1
			: 0;

	console.log(`MODEL_APPLIED=${modelApplied}`);
	console.log(`NOTIF_ON_CHANGE=${notificationOnChange}`);
	console.log(`NOTIF_ON_NOOP=${notificationOnNoop}`);
	console.log(`UNSUPPORTED_REJECTED=${unsupportedRejected}`);
	console.log("EXIT=0");
	if (modelApplied !== 1 || notificationOnChange !== 1 || notificationOnNoop !== 0 || unsupportedRejected !== 1) {
		throw new Error("task15 settings assertions failed");
	}
	harness.lifecycle.dispose();
} finally {
	sessionHarness.cleanup();
	await rm(root, { recursive: true, force: true });
}
