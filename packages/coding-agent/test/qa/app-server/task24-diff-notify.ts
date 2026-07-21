import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPortReusable, findQaPort, startSourceServer } from "./task23-fuzzy-client.ts";
import { connectTask24Client, type Task24Client, type WireRecord } from "./task24-diff-client.ts";
import { startTask24FakeModel, TASK24_MODEL, TASK24_PROVIDER, type Task24FakeModel } from "./task24-diff-model.ts";

const codingAgentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repoRoot = resolve(codingAgentDir, "../..");
const root = await mkdtemp(join(tmpdir(), "senpi-task24-diff-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const homeDir = join(root, "home");
const tempDir = join(root, "tmp");
const cwd = join(root, "cwd");
let fake: Task24FakeModel | undefined;
let appPort: number | undefined;
let child: ChildProcess | undefined;
let subscriber: Task24Client | undefined;
let outsider: Task24Client | undefined;

try {
	await Promise.all([agentDir, sessionDir, homeDir, tempDir, cwd].map((path) => mkdir(path, { recursive: true })));
	await Promise.all([writeFile(join(cwd, "one.txt"), "one old\n"), writeFile(join(cwd, "two.txt"), "two old\n")]);
	fake = await startTask24FakeModel();
	await writeModelConfig(fake.origin);
	appPort = await findQaPort();
	child = await startSourceServer({ repoRoot, codingAgentDir, port: appPort, env: hermeticEnv() });
	[subscriber, outsider] = await Promise.all([connectTask24Client(appPort), connectTask24Client(appPort)]);
	await Promise.all([initialize(subscriber, "subscriber"), initialize(outsider, "outsider")]);

	const started = resultRecord(
		await subscriber.request("thread/start", {
			cwd,
			model: `${TASK24_PROVIDER}/${TASK24_MODEL}`,
			modelProvider: TASK24_PROVIDER,
			approvalPolicy: "never",
		}),
		"thread/start",
	);
	const threadId = stringAt(recordAt(started, "thread"), "id");

	const firstSubscriberMark = subscriber.mark();
	const firstOutsiderMark = outsider.mark();
	const firstTurnId = await startTurnAndWait(subscriber, threadId, "Make both requested fixture edits.");
	await outsider.request("model/list", {});
	const firstFrames = subscriber.notificationsSince(firstSubscriberMark);
	const firstOutsiderFrames = outsider.notificationsSince(firstOutsiderMark);

	const webSearchFrames = firstFrames.filter(isWebSearchLifecycle);
	assert.deepEqual(
		webSearchFrames.map((frame) => frame.method),
		["item/started", "item/completed"],
	);
	for (const frame of webSearchFrames) {
		const item = recordAt(recordAt(frame, "params"), "item");
		assert.equal(item.query, "senpi parity");
		assert.deepEqual(item.action, { type: "search", query: "senpi parity", queries: null });
		assert.equal(item.results, null);
		assertTimestamp(frame);
	}

	const diffFrames = firstFrames.filter((frame) => frame.method === "turn/diff/updated");
	assert.equal(diffFrames.length, 2);
	const diffs = diffFrames.map((frame) => {
		const params = recordAt(frame, "params");
		assert.equal(params.threadId, threadId);
		assert.equal(params.turnId, firstTurnId);
		assertTimestamp(frame);
		return stringAt(params, "diff");
	});
	const firstDiff = diffs[0] ?? "";
	const secondDiff = diffs[1] ?? "";
	assert.ok(firstDiff.includes("one.txt"));
	assert.ok(secondDiff.startsWith(firstDiff));
	assert.ok(secondDiff.slice(firstDiff.length).includes("two.txt"));
	assert.equal(
		firstOutsiderFrames.some((frame) => frame.method === "turn/diff/updated"),
		false,
	);
	assert.equal(firstOutsiderFrames.some(isWebSearchLifecycle), false);
	assert.equal(await readFile(join(cwd, "one.txt"), "utf8"), "one new\n");
	assert.equal(await readFile(join(cwd, "two.txt"), "utf8"), "two new\n");

	const secondSubscriberMark = subscriber.mark();
	const secondOutsiderMark = outsider.mark();
	await startTurnAndWait(subscriber, threadId, "Reply without changing files.");
	await outsider.request("model/list", {});
	assert.equal(
		subscriber.notificationsSince(secondSubscriberMark).some((frame) => frame.method === "turn/diff/updated"),
		false,
	);
	assert.equal(
		outsider.notificationsSince(secondOutsiderMark).some((frame) => frame.method === "turn/diff/updated"),
		false,
	);
	assert.equal(fake.responseCount(), 4);
	resultRecord(await subscriber.request("thread/archive", { threadId }), "thread/archive");

	console.log("WEBSEARCH_SHAPE=1");
	console.log("DIFF_EVENTS=2");
	console.log("DIFFLESS_SILENT=1");
	console.log("SUBSCRIBER_ONLY=1");
	console.log("TIMESTAMPS=1");
	console.log("MODEL_REQUESTS=4");
	console.log("MODEL_TOKENS=0");
} finally {
	await Promise.allSettled([subscriber?.close(), outsider?.close()]);
	if (child) await stopTask24SourceServer(child);
	await fake?.stop();
	await rm(root, { recursive: true, force: true });
	if (appPort !== undefined) await assertPortReusable(appPort);
	if (fake) await assertPortReusable(fake.port);
}

async function stopTask24SourceServer(activeChild: ChildProcess): Promise<void> {
	if (activeChild.exitCode !== null || activeChild.signalCode !== null) return;
	const gracefulExit = waitForProcessExit(activeChild, 10_000);
	activeChild.kill("SIGTERM");
	if (!(await gracefulExit)) {
		const forcedExit = waitForProcessExit(activeChild, 5_000);
		activeChild.kill("SIGTERM");
		if (!(await forcedExit)) {
			const killed = waitForProcessExit(activeChild, 5_000);
			activeChild.kill("SIGKILL");
			if (!(await killed)) throw new Error("source app-server process did not exit");
		}
	}
	activeChild.stdin?.destroy();
	activeChild.stdout?.destroy();
	activeChild.stderr?.destroy();
}

function waitForProcessExit(activeChild: ChildProcess, timeoutMs: number): Promise<boolean> {
	return new Promise((resolveExit) => {
		const onExit = (): void => {
			clearTimeout(timer);
			resolveExit(true);
		};
		const timer = setTimeout(() => {
			activeChild.off("exit", onExit);
			resolveExit(false);
		}, timeoutMs);
		activeChild.once("exit", onExit);
	});
}

async function writeModelConfig(origin: string): Promise<void> {
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[TASK24_PROVIDER]: {
					api: "openai-responses",
					baseUrl: origin,
					apiKey: "local-task24-key",
					models: [
						{
							id: TASK24_MODEL,
							api: "openai-responses",
							baseUrl: origin,
							contextWindow: 100_000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
}

function hermeticEnv(): NodeJS.ProcessEnv {
	return {
		CI: "1",
		HOME: homeDir,
		LANG: "C.UTF-8",
		NO_COLOR: "1",
		NO_PROXY: "127.0.0.1,localhost",
		PATH: process.env.PATH,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		SENPI_CODING_AGENT_DIR: agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
		TMPDIR: tempDir,
		USERPROFILE: homeDir,
		XDG_CACHE_HOME: join(root, "xdg-cache"),
		XDG_CONFIG_HOME: join(root, "xdg-config"),
		XDG_DATA_HOME: join(root, "xdg-data"),
	};
}

async function initialize(client: Task24Client, name: string): Promise<void> {
	resultRecord(
		await client.request("initialize", {
			clientInfo: { name: `task24-${name}`, title: `Task 24 ${name}`, version: "0.0.1" },
			capabilities: { experimentalApi: false, requestAttestation: false },
		}),
		"initialize",
	);
}

async function startTurnAndWait(client: Task24Client, threadId: string, text: string): Promise<string> {
	const result = resultRecord(
		await client.request("turn/start", { threadId, input: [{ type: "text", text }] }),
		"turn/start",
	);
	const turnId = stringAt(recordAt(result, "turn"), "id");
	await client.waitForNotification(
		(frame) =>
			frame.method === "turn/completed" &&
			isRecord(frame.params) &&
			frame.params.threadId === threadId &&
			isRecord(frame.params.turn) &&
			frame.params.turn.id === turnId,
	);
	return turnId;
}

function isWebSearchLifecycle(frame: WireRecord): boolean {
	if (frame.method !== "item/started" && frame.method !== "item/completed") return false;
	return isRecord(frame.params) && isRecord(frame.params.item) && frame.params.item.type === "webSearch";
}

function assertTimestamp(frame: WireRecord): void {
	const timestamp = frame.emittedAtMs;
	if (typeof timestamp !== "number" || timestamp <= 0) throw new Error("emittedAtMs was not populated");
}

function resultRecord(response: WireRecord, method: string): WireRecord {
	if ("error" in response) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
	return recordAt(response, "result");
}

function recordAt(value: WireRecord, key: string): WireRecord {
	const child = value[key];
	if (!isRecord(child)) throw new Error(`${key} was not an object`);
	return child;
}

function stringAt(value: WireRecord, key: string): string {
	const child = value[key];
	if (typeof child !== "string") throw new Error(`${key} was not a string`);
	return child;
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
