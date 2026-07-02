import { spawnSync } from "node:child_process";
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
	SERVER_NOTIFICATION_METHODS,
	SERVER_REQUEST_METHODS,
	STABLE_CLIENT_REQUEST_METHODS,
} from "../../src/modes/app-server/protocol/methods.ts";

const generatedDir = join(process.cwd(), "src/modes/app-server/protocol/generated");
const researchDir = join(process.cwd(), "../../.omo/ulw-research/20260702-114518/raw/schema-ts-experimental");

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

describe("app-server protocol metadata", () => {
	it("ships the expected generated protocol method groups", () => {
		expect(STABLE_CLIENT_REQUEST_METHODS).toHaveLength(90);
		expect(EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS).toHaveLength(34);
		expect(SERVER_NOTIFICATION_METHODS).toHaveLength(69);
		expect(SERVER_REQUEST_METHODS).toHaveLength(11);

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

		const allMethods = groups.flat();
		expect(new Set(allMethods).size).toBe(allMethods.length);
	});

	it("vendors the full generated TypeScript tree byte-for-byte", () => {
		const generatedFiles = relativeTypeScriptFiles(generatedDir);
		const researchFiles = relativeTypeScriptFiles(researchDir);

		expect(generatedFiles.length).toBeGreaterThanOrEqual(500);
		expect(generatedFiles).toEqual(researchFiles);

		for (const path of generatedFiles) {
			expect(readFileSync(join(generatedDir, path), "utf8")).toBe(readFileSync(join(researchDir, path), "utf8"));
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
		const threadLoadedListResponse: ThreadLoadedListResponse = { data: [thread], nextCursor: null };
		const modelListResponse: ModelListResponse = { data: [{ id: "mock-model" }], nextCursor: null };
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
		expect(threadLoadedListResponse.data[0]?.sessionId).toBe("session-1");
		expect(modelListResponse.data[0]).toEqual({ id: "mock-model" });
		expect(notification.method).toBe("thread/status/changed");
		expect(serverRequest.id).toBe("approval-1");
	});

	it("loads method metadata from the runtime .js import path", () => {
		const result = spawnSync(
			"npx",
			[
				"tsx",
				"-e",
				'import {STABLE_CLIENT_REQUEST_METHODS} from "./src/modes/app-server/protocol/methods.js"; console.log("COUNT="+STABLE_CLIENT_REQUEST_METHODS.length, STABLE_CLIENT_REQUEST_METHODS.includes("thread/start"))',
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
			},
		);

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("COUNT=90 true");
	});
});
