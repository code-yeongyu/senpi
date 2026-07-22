import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";

const root = await mkdtemp(join(tmpdir(), "senpi-task22-catalogs-"));
const agentDir = join(root, "agent");
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey("task22-faux", "faux-key");
const modelRegistry = ModelRegistry.inMemory(authStorage);
modelRegistry.registerProvider("task22-faux", {
	baseUrl: "http://127.0.0.1:18990",
	apiKey: "faux-key",
	api: "faux",
	models: [
		{
			id: "catalog-model",
			name: "Task 22 Catalog Model",
			api: "faux",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1024,
			maxTokens: 256,
			baseUrl: "http://127.0.0.1:18990",
		},
	],
});

const core = new ServerCore({
	modelRegistry,
	codexHome: agentDir,
	serverCwd: root,
	version: "2026.7.2",
});
const sent: unknown[] = [];
const connection = core.addConnection({
	id: "task22-catalogs",
	transportKind: "stdio",
	send: (message) => {
		sent.push(message);
	},
	close: () => undefined,
});

try {
	await core.receive(connection.id, {
		kind: "request",
		message: {
			id: 1,
			method: "initialize",
			params: {
				clientInfo: { name: "qa", title: "QA", version: "0.0.1" },
				capabilities: { experimentalApi: true, requestAttestation: false },
			},
		},
	});

	await core.receive(connection.id, {
		kind: "request",
		message: { id: 2, method: "collaborationMode/list", params: {} },
	});
	const collaboration = resultRecord(sent[1]);
	const preset = arrayAt(collaboration, "data")[0];
	const collaborationSnakeMember =
		isRecord(preset) &&
		preset.name === "default" &&
		preset.mode === null &&
		preset.model === "catalog-model" &&
		preset.reasoning_effort === null &&
		!("reasoningEffort" in preset)
			? 1
			: 0;

	await core.receive(connection.id, {
		kind: "request",
		message: { id: 3, method: "permissionProfile/list", params: { cwd: ".", cursor: null, limit: 0 } },
	});
	const profiles = resultRecord(sent[2]);
	const profileData = arrayAt(profiles, "data");
	const profilesPinned = profileData.some(
		(profile) =>
			isRecord(profile) &&
			profile.id === "dangerFullAccess" &&
			profile.description === null &&
			profile.allowed === true,
	);

	await core.receive(connection.id, {
		kind: "request",
		message: { id: 4, method: "experimentalFeature/list", params: { cursor: null, limit: 0 } },
	});
	const features = resultRecord(sent[3]);
	const featuresPaged =
		Array.isArray(features.data) && (features.nextCursor === null || typeof features.nextCursor === "string") ? 1 : 0;

	await core.receive(connection.id, {
		kind: "request",
		message: {
			id: 5,
			method: "experimentalFeature/list",
			params: { threadId: "missing-loaded-thread", limit: 1 },
		},
	});
	const unknownThreadRejected = errorCode(sent[4]) === -32600 ? 1 : 0;

	console.log(`COLLAB_SNAKE_MEMBER=${collaborationSnakeMember}`);
	console.log(`PROFILES=${profileData.length}`);
	console.log(`PROFILES_PINNED=${profilesPinned ? 1 : 0}`);
	console.log(`FEATURES_PAGED=${featuresPaged}`);
	console.log(`UNKNOWN_THREAD_REJECTED=${unknownThreadRejected}`);
	console.log("EXIT=0");
	if (collaborationSnakeMember !== 1 || !profilesPinned || featuresPaged !== 1 || unknownThreadRejected !== 1) {
		throw new Error("task22 catalog assertions failed");
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

function resultRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || !isRecord(value.result)) {
		throw new Error(`catalog method did not return a result: ${JSON.stringify(value)}`);
	}
	return value.result;
}

function arrayAt(record: Record<string, unknown>, key: string): readonly unknown[] {
	const value = record[key];
	if (!Array.isArray(value)) throw new Error(`catalog result field ${key} is not an array`);
	return value;
}

function errorCode(value: unknown): number | undefined {
	if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "number") return undefined;
	return value.error.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
