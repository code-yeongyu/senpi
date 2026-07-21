import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertPortReusable,
	connectClient,
	type FuzzyQaClient,
	findQaPort,
	startSourceServer,
	stopSourceServer,
	type WireRecord,
} from "./task23-fuzzy-client.ts";

const codingAgentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repoRoot = resolve(codingAgentDir, "../..");
const root = await mkdtemp(join(tmpdir(), "senpi-task23-fuzzy-"));
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const homeDir = join(root, "home");
const tempDir = join(root, "tmp");
const fixtureRoot = join(root, "fixture");
const sourceDir = join(fixtureRoot, "src");
const port = await findQaPort();
let child: ChildProcess | undefined;
let client: FuzzyQaClient | undefined;

try {
	await Promise.all(
		[agentDir, sessionDir, homeDir, tempDir, sourceDir].map((path) => mkdir(path, { recursive: true })),
	);
	await writeFile(join(sourceDir, "AlphaBetaCode.ts"), "export const marker = true;\n");
	await writeFile(join(sourceDir, "😀Alpha.ts"), "export const unicodeMarker = true;\n");
	await writeFile(join(fixtureRoot, "cancel-target.txt"), "cancel\n");
	await writeFile(join(fixtureRoot, "ignored.txt"), "ignored\n");
	await writeFile(join(fixtureRoot, ".gitignore"), "ignored.txt\n");
	child = await startSourceServer({ repoRoot, codingAgentDir, port, env: hermeticEnv() });
	client = await connectClient(port);
	await initialize(client);

	const oneShot = resultRecord(
		await client.request("fuzzyFileSearch", { query: "abc", roots: [fixtureRoot], cancellationToken: null }),
		"fuzzyFileSearch",
	);
	const oneShotFiles = arrayField(oneShot, "files");
	const alpha = oneShotFiles.find((value) => isRecord(value) && value.path === "src/AlphaBetaCode.ts");
	assert.ok(isRecord(alpha));
	const indices = numberArray(alpha.indices);
	assert.deepEqual(
		indices,
		[...indices].sort((left, right) => left - right),
	);
	const unicodeSearch = resultRecord(
		await client.request("fuzzyFileSearch", { query: "😀a", roots: [fixtureRoot], cancellationToken: null }),
		"unicode fuzzyFileSearch",
	);
	const unicodeFiles = arrayField(unicodeSearch, "files");
	const unicodeMatch = unicodeFiles.find((value) => isRecord(value) && value.path === "src/😀Alpha.ts");
	assert.ok(isRecord(unicodeMatch));
	assert.deepEqual(numberArray(unicodeMatch.indices), [4, 5]);

	const prior = client.request("fuzzyFileSearch", {
		query: "cancel-target",
		roots: [fixtureRoot],
		cancellationToken: "replace-me",
	});
	const replacement = client.request("fuzzyFileSearch", {
		query: "cancel-target",
		roots: [fixtureRoot],
		cancellationToken: "replace-me",
	});
	const [priorResult, replacementResult] = await Promise.all([prior, replacement]);
	const priorFiles = arrayField(resultRecord(priorResult, "prior fuzzyFileSearch"), "files");
	const replacementFiles = arrayField(resultRecord(replacementResult, "replacement fuzzyFileSearch"), "files");
	assert.equal(priorFiles.length, 0);
	assert.ok(replacementFiles.length >= 1);

	const sessionId = "task23-session";
	const updated = client.waitForNotification(
		(notification) =>
			notification.method === "fuzzyFileSearch/sessionUpdated" &&
			isRecord(notification.params) &&
			notification.params.sessionId === sessionId &&
			notification.params.query === "abc",
	);
	const completed = client.waitForNotification(
		(notification) =>
			notification.method === "fuzzyFileSearch/sessionCompleted" &&
			isRecord(notification.params) &&
			notification.params.sessionId === sessionId,
	);
	let completionCount = 0;
	const completedAgain = client.waitForNotification((notification) => {
		if (
			notification.method !== "fuzzyFileSearch/sessionCompleted" ||
			!isRecord(notification.params) ||
			notification.params.sessionId !== sessionId
		) {
			return false;
		}
		completionCount += 1;
		return completionCount === 2;
	});
	resultRecord(
		await client.request("fuzzyFileSearch/sessionStart", { sessionId, roots: [fixtureRoot] }),
		"fuzzyFileSearch/sessionStart",
	);
	resultRecord(
		await client.request("fuzzyFileSearch/sessionUpdate", { sessionId, query: "abc" }),
		"fuzzyFileSearch/sessionUpdate",
	);
	const [updatedNotification] = await Promise.all([updated, completed]);
	assert.ok(isRecord(updatedNotification.params));
	assert.ok(arrayField(updatedNotification.params, "files").length >= 1);
	const updatedAgain = client.waitForNotification(
		(notification) =>
			notification.method === "fuzzyFileSearch/sessionUpdated" &&
			isRecord(notification.params) &&
			notification.params.sessionId === sessionId &&
			notification.params.query === "zzzz",
	);
	resultRecord(
		await client.request("fuzzyFileSearch/sessionUpdate", { sessionId, query: "zzzz" }),
		"second fuzzyFileSearch/sessionUpdate",
	);
	const [updatedAgainNotification] = await Promise.all([updatedAgain, completedAgain]);
	assert.ok(isRecord(updatedAgainNotification.params));
	assert.equal(arrayField(updatedAgainNotification.params, "files").length, 0);
	resultRecord(await client.request("fuzzyFileSearch/sessionStop", { sessionId }), "fuzzyFileSearch/sessionStop");

	console.log(`ONESHOT_HITS=${oneShotFiles.length}`);
	console.log("INDICES_OK=1");
	console.log("CANCELLED_PRIOR=1");
	console.log("SESSION_UPDATED=1");
	console.log("SESSION_COMPLETED=1");
	console.log("SESSION_RECOMPLETED=1");
	console.log("EXIT=0");
} finally {
	await client?.close();
	if (child) await stopSourceServer(child);
	await rm(root, { recursive: true, force: true });
	await assertPortReusable(port);
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

async function initialize(activeClient: FuzzyQaClient): Promise<void> {
	resultRecord(
		await activeClient.request("initialize", {
			clientInfo: { name: "task23-qa", title: "Task 23 QA", version: "0.0.1" },
			capabilities: { experimentalApi: true, requestAttestation: false },
		}),
		"initialize",
	);
}

function resultRecord(response: WireRecord, method: string): WireRecord {
	if ("error" in response) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
	if (!isRecord(response.result)) throw new Error(`${method} result was not an object`);
	return response.result;
}

function arrayField(record: WireRecord, key: string): readonly unknown[] {
	const value = record[key];
	if (!Array.isArray(value)) throw new Error(`${key} was not an array`);
	return value;
}

function numberArray(value: unknown): readonly number[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "number")) {
		throw new Error("indices were not numeric");
	}
	return value;
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
