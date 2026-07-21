import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	ClientRequest,
	InitializeParams,
	InitializeResponse,
	ModelListResponse,
	ServerNotification,
	ServerRequest,
	Thread,
	ThreadListResponse,
	ThreadLoadedListResponse,
	ThreadStartParams,
	TurnStartParams,
} from "../../src/modes/app-server/protocol/index.ts";
import {
	EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS,
	EXPERIMENTAL_SERVER_NOTIFICATION_METHODS,
	SERVER_NOTIFICATION_METHODS,
	SERVER_REQUEST_METHODS,
	STABLE_CLIENT_REQUEST_METHODS,
} from "../../src/modes/app-server/protocol/methods.ts";

const generatedDir = join(process.cwd(), "src/modes/app-server/protocol/generated");
const generatedManifestPath = join(process.cwd(), "test/goldens/app-server-protocol-generated-tree.sha256");
const capabilityManifestPath = join(process.cwd(), "test/qa/app-server/capability-manifest.json");
const headMethodsFixturePath = join(process.cwd(), "test/fixtures/app-server-methods-codex-head.json");

type CapabilityManifest = {
	readonly implemented: {
		readonly stable: readonly string[];
		readonly experimental: readonly string[];
	};
	readonly out: {
		readonly stable: readonly string[];
		readonly experimental: readonly string[];
	};
	readonly catalogCounts: {
		readonly serverNotifications: number;
		readonly serverRequests: number;
	};
};

type HeadMethodsFixture = {
	readonly provenance: {
		readonly codexGit: string;
		readonly source: string;
	};
	readonly stableClientRequests: readonly string[];
	readonly experimentalClientRequests: readonly string[];
	readonly serverNotifications: readonly string[];
	readonly experimentalServerNotifications: readonly string[];
	readonly serverRequests: readonly string[];
};

function expectSortedDistinct(methods: readonly string[]): void {
	const sorted = [...methods].sort();
	expect(methods).toEqual(sorted);
	expect(new Set(methods).size).toBe(methods.length);
}

function listTypeScriptFiles(dir: string): string[] {
	const entries = readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		const stats = statSync(path);

		if (stats.isDirectory()) {
			return listTypeScriptFiles(path);
		}

		return path.endsWith(".ts") ? [path] : [];
	});

	return entries.sort();
}

function relativeTypeScriptFiles(dir: string): string[] {
	return listTypeScriptFiles(dir).map((path) => relative(dir, path));
}

function readGeneratedManifest(): Map<string, string> {
	const entries = new Map<string, string>();
	const lines = readFileSync(generatedManifestPath, "utf8").trim().split("\n");

	for (const line of lines) {
		const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
		if (match === null) {
			throw new Error(`Invalid generated manifest line: ${line}`);
		}

		const hash = match[1];
		const path = match[2];
		if (hash === undefined || path === undefined) {
			throw new Error(`Invalid generated manifest capture: ${line}`);
		}

		entries.set(path, hash);
	}

	return entries;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("app-server protocol metadata", () => {
	it("matches the method catalogs extracted from pinned Codex HEAD", () => {
		// Given: the checked-in common.rs extraction at the protocol pin.
		const fixture: HeadMethodsFixture = JSON.parse(readFileSync(headMethodsFixturePath, "utf8"));

		// When/Then: every runtime catalog matches the pinned source catalog exactly.
		expect(fixture.provenance.codexGit).toBe("0fb559f0f6e231a88ac02ea002d3ecd248e2b515");
		expect(fixture.provenance.source).toBe("codex-rs/app-server-protocol/src/protocol/common.rs");
		expect(STABLE_CLIENT_REQUEST_METHODS).toEqual(fixture.stableClientRequests);
		expect(EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS).toEqual(fixture.experimentalClientRequests);
		expect(SERVER_NOTIFICATION_METHODS).toEqual(fixture.serverNotifications);
		expect(EXPERIMENTAL_SERVER_NOTIFICATION_METHODS).toEqual(fixture.experimentalServerNotifications);
		expect(SERVER_REQUEST_METHODS).toEqual(fixture.serverRequests);
	});

	it("ships the expected generated protocol method groups", () => {
		const manifest = readCapabilityManifest();
		expect(STABLE_CLIENT_REQUEST_METHODS).toHaveLength(
			manifest.implemented.stable.length + manifest.out.stable.length,
		);
		expect(EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS).toHaveLength(
			manifest.implemented.experimental.length + manifest.out.experimental.length,
		);
		expect(SERVER_NOTIFICATION_METHODS).toHaveLength(manifest.catalogCounts.serverNotifications);
		expect(SERVER_REQUEST_METHODS).toHaveLength(manifest.catalogCounts.serverRequests);
		expect([...manifest.implemented.stable, ...manifest.out.stable].sort()).toEqual(
			[...STABLE_CLIENT_REQUEST_METHODS].sort(),
		);
		expect([...manifest.implemented.experimental, ...manifest.out.experimental].sort()).toEqual(
			[...EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS].sort(),
		);

		expect(STABLE_CLIENT_REQUEST_METHODS).toContain("initialize");
		expect(STABLE_CLIENT_REQUEST_METHODS).toContain("thread/start");
		expect(STABLE_CLIENT_REQUEST_METHODS).toContain("turn/steer");
		expect(EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS).toContain("remoteControl/status/read");
		expect(SERVER_NOTIFICATION_METHODS).toContain("turn/started");
		expect(SERVER_REQUEST_METHODS).toContain("item/commandExecution/requestApproval");
	});

	it("keeps method groups sorted, distinct, and non-overlapping", () => {
		const groups = [
			STABLE_CLIENT_REQUEST_METHODS,
			EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS,
			SERVER_NOTIFICATION_METHODS,
			SERVER_REQUEST_METHODS,
		];

		for (const methods of groups) {
			expectSortedDistinct(methods);
		}
		expectSortedDistinct(EXPERIMENTAL_SERVER_NOTIFICATION_METHODS);
		for (const method of EXPERIMENTAL_SERVER_NOTIFICATION_METHODS) {
			expect(SERVER_NOTIFICATION_METHODS).toContain(method);
		}

		const allMethods = groups.flat();
		expect(new Set(allMethods).size).toBe(allMethods.length);
	});

	it("matches the committed generated TypeScript tree manifest", () => {
		const generatedFiles = relativeTypeScriptFiles(generatedDir);
		const manifest = readGeneratedManifest();

		expect(generatedFiles.length).toBeGreaterThanOrEqual(500);
		expect(generatedFiles).toEqual([...manifest.keys()]);

		for (const path of generatedFiles) {
			expect(sha256File(join(generatedDir, path))).toBe(manifest.get(path));
		}
	});

	it("supports representative facade protocol values without importing generated files", () => {
		const initializeParams: InitializeParams = {
			clientInfo: {
				name: "senpi",
				title: null,
				version: "0.0.0",
			},
			capabilities: {
				experimentalApi: true,
				requestAttestation: false,
			},
		};
		const initializeResponse: InitializeResponse = {
			userAgent: "senpi-test",
			codexHome: "/tmp/codex",
			platformFamily: "unix",
			platformOs: "darwin",
		};
		const thread: Thread = {
			id: "thread-1",
			sessionId: "session-1",
			forkedFromId: null,
			parentThreadId: null,
			preview: "",
			ephemeral: false,
			modelProvider: "mock",
			createdAt: 1,
			updatedAt: 1,
			recencyAt: null,
			status: { type: "idle" },
			path: null,
			cwd: "/tmp",
			cliVersion: "0.0.0",
			source: "appServer",
			threadSource: null,
			agentNickname: null,
			agentRole: null,
			gitInfo: null,
			name: null,
			turns: [],
		};
		const threadStartParams: ThreadStartParams = { model: "mock-model", cwd: "/tmp" };
		const turnStartParams: TurnStartParams = { threadId: "thread-1", input: [{ type: "text", text: "hi" }] };
		const threadListResponse: ThreadListResponse = { data: [thread], nextCursor: null, backwardsCursor: null };
		const threadLoadedListResponse: ThreadLoadedListResponse = { data: ["thread-1"], nextCursor: null };
		const modelListResponse: ModelListResponse = {
			data: [
				{
					id: "mock/mock-model",
					model: "mock-model",
					upgrade: null,
					upgradeInfo: null,
					availabilityNux: null,
					displayName: "Mock Model",
					description: "",
					hidden: false,
					supportedReasoningEfforts: [],
					defaultReasoningEffort: "medium",
					inputModalities: ["text"],
					supportsPersonality: false,
					additionalSpeedTiers: [],
					serviceTiers: [],
					defaultServiceTier: null,
					isDefault: false,
				},
			],
			nextCursor: null,
		};
		const request: ClientRequest = { method: "initialize", id: 1, params: initializeParams };
		const notification: ServerNotification = { method: "thread/status/changed", params: { threadId: "thread-1" } };
		const serverRequest: ServerRequest = {
			method: "item/commandExecution/requestApproval",
			id: "approval-1",
			params: { threadId: "thread-1" },
		};

		expect(request.params).toEqual(initializeParams);
		expect(initializeResponse.platformOs).toBe("darwin");
		expect(threadStartParams.cwd).toBe("/tmp");
		expect(turnStartParams.input[0]?.type).toBe("text");
		expect(threadListResponse.data[0]?.id).toBe("thread-1");
		expect(threadLoadedListResponse.data[0]).toBe("thread-1");
		expect(modelListResponse.data[0]?.id).toBe("mock/mock-model");
		expect(notification.method).toBe("thread/status/changed");
		expect(serverRequest.id).toBe("approval-1");
	});

	it("loads method metadata from the runtime .js import path", () => {
		const manifest = readCapabilityManifest();
		const stableCount = manifest.implemented.stable.length + manifest.out.stable.length;
		const result = spawnSync(
			"npx",
			[
				"tsx",
				"-e",
				'import {EXPERIMENTAL_SERVER_NOTIFICATION_METHODS,STABLE_CLIENT_REQUEST_METHODS} from "./src/modes/app-server/protocol/methods.js"; console.log("STABLE="+STABLE_CLIENT_REQUEST_METHODS.length,"EXPERIMENTAL_NOTIFICATIONS="+EXPERIMENTAL_SERVER_NOTIFICATION_METHODS.length,STABLE_CLIENT_REQUEST_METHODS.includes("thread/start"),EXPERIMENTAL_SERVER_NOTIFICATION_METHODS.includes("thread/settings/updated"))',
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
			},
		);

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`STABLE=${stableCount} EXPERIMENTAL_NOTIFICATIONS=14 true true`);
	});
});

function readCapabilityManifest(): CapabilityManifest {
	const manifest: CapabilityManifest = JSON.parse(readFileSync(capabilityManifestPath, "utf8"));
	return manifest;
}
