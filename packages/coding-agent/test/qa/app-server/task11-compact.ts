import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	longTranscript,
	numberAt,
	recordAt,
	StdioClient,
	spawnAppServer,
	startFakeModel,
	stringAt,
	stringAtOrNull,
	writeMockModels,
} from "./task11-compact-support.ts";

async function main(): Promise<void> {
	const fake = await startFakeModel();
	const root = await mkdtemp(join(tmpdir(), "senpi-task11-compact-"));
	let client: StdioClient | undefined;
	try {
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const cwd = join(root, "cwd");
		await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(cwd)]);
		await writeMockModels(agentDir, fake.port);
		const child = spawnAppServer(root, agentDir, sessionDir);
		client = new StdioClient(child);
		await client.request("initialize", { clientInfo: { name: "task11", version: "0.0.0" }, capabilities: {} });
		client.notify("initialized");

		const started = await client.request("thread/start", {
			cwd,
			model: "mock/mock-model",
			modelProvider: "mock",
			approvalPolicy: "never",
		});
		const threadId = stringAt(recordAt(recordAt(started.message, "result"), "thread"), "id");
		for (let turnIndex = 0; turnIndex < 2; turnIndex += 1) {
			const turnStart = await client.request("turn/start", {
				threadId,
				input: [{ type: "text", text: `seed-${turnIndex} ${longTranscript()}` }],
			});
			await client.waitForMessage(
				(message) =>
					message.method === "turn/completed" &&
					stringAtOrNull(recordAt(message, "params"), "threadId") === threadId,
				turnStart.index,
			);
		}

		const compactMark = client.mark();
		const responsePromise = client.rawRequest("thread/compact/start", { threadId });
		const startedItemPromise = client.waitForMessage(
			(message) =>
				message.method === "item/started" && stringAtOrNull(recordAt(message, "params"), "threadId") === threadId,
			compactMark,
		);
		const completedItemPromise = client.waitForMessage(
			(message) =>
				message.method === "item/completed" && stringAtOrNull(recordAt(message, "params"), "threadId") === threadId,
			compactMark,
		);
		const [response, startedItem, completedItem] = await Promise.all([
			responsePromise,
			startedItemPromise,
			completedItemPromise,
		]);

		const startedParams = recordAt(startedItem.message, "params");
		const completedParams = recordAt(completedItem.message, "params");
		const startedWireItem = recordAt(startedParams, "item");
		const completedWireItem = recordAt(completedParams, "item");
		const compactionItemSeen =
			startedWireItem.type === "contextCompaction" &&
			completedWireItem.type === "contextCompaction" &&
			startedWireItem.id === completedWireItem.id &&
			startedParams.turnId === completedParams.turnId
				? 1
				: 0;
		const threadCompactedFrames = client.messages
			.slice(compactMark)
			.filter((message) => message.method === "thread/compacted").length;
		const responseBeforeStarted = response.index < startedItem.index ? 1 : 0;

		await client.request("thread/archive", { threadId });
		const unloaded = await client.rawRequest("thread/compact/start", { threadId });
		const unloadedError =
			numberAt(recordAt(unloaded.message, "error"), "code") === -32600 &&
			stringAtOrNull(recordAt(unloaded.message, "error"), "message")?.includes("thread not found") === true
				? 1
				: 0;

		console.log(`ACK_IMMEDIATE=${responseBeforeStarted}`);
		console.log(`RESPONSE_INDEX=${response.index}`);
		console.log(`ITEM_STARTED_INDEX=${startedItem.index}`);
		console.log(`WIRE_ORDER=${responseBeforeStarted === 1 ? "response-before-started" : "started-before-response"}`);
		console.log(`COMPACTION_ITEM_SEEN=${compactionItemSeen}`);
		console.log(`THREAD_COMPACTED_FRAMES=${threadCompactedFrames}`);
		console.log(`UNLOADED_ERROR=${unloadedError}`);
		if (
			responseBeforeStarted !== 1 ||
			compactionItemSeen !== 1 ||
			threadCompactedFrames !== 0 ||
			unloadedError !== 1
		) {
			throw new Error("task11 compact assertions failed");
		}
	} finally {
		await client?.close();
		await rm(root, { recursive: true, force: true });
		await fake.stop();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
