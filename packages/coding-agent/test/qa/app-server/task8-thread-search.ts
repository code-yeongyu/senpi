import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, StdioClient, spawnServer, type WireRecord, writeSession } from "./task8-thread-search-support.ts";

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-task8-search-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "cwd");
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(cwd)]);
	const activeId = "40000000-0000-4000-8000-000000000001";
	const archivedId = "40000000-0000-4000-8000-000000000002";
	const assistantRecentId = "40000000-0000-4000-8000-000000000003";
	const userRecentId = "40000000-0000-4000-8000-000000000004";
	await writeSession(sessionDir, activeId, "Wire NEEDLE hit");
	await writeSession(sessionDir, archivedId, "Archived needle hit");
	await writeSession(sessionDir, assistantRecentId, "recency probe first", {
		userTimestamp: "2026-07-02T00:00:01.000Z",
		assistantTimestamp: "2026-07-02T00:00:10.000Z",
	});
	await writeSession(sessionDir, userRecentId, "recency probe second", {
		userTimestamp: "2026-07-02T00:00:05.000Z",
		assistantTimestamp: "2026-07-02T00:00:06.000Z",
	});

	const enabled = new StdioClient(spawnServer(root, agentDir, sessionDir, true));
	const disabled = new StdioClient(spawnServer(root, agentDir, sessionDir, false));
	try {
		await initialize(enabled, "task8-enabled");
		await initialize(disabled, "task8-disabled");
		const archive = await enabled.request("thread/archive", { threadId: archivedId });
		assertResult(archive, "thread/archive");

		const defaultSearch = await enabled.request("thread/search", { searchTerm: "needle" });
		const emptySourceSearch = await enabled.request("thread/search", { searchTerm: "needle", sourceKinds: [] });
		const search = await enabled.request("thread/search", {
			searchTerm: "  needle  ",
			sourceKinds: ["appServer"],
		});
		const searchResult = resultRecord(search, "thread/search");
		const data = arrayValue(searchResult.data);
		const first = recordValue(data[0]);
		const snippet = typeof first?.snippet === "string" ? first.snippet : "";
		const empty = await enabled.request("thread/search", { searchTerm: "   " });
		const gated = await disabled.request("thread/search", { searchTerm: "needle" });
		const invalidSource = await enabled.request("thread/search", {
			searchTerm: "needle",
			sourceKinds: ["not-a-source-kind"],
		});
		const malformed = await Promise.all(
			[{ limit: -1 }, { limit: 1.5 }, { limit: 0x1_0000_0000 }, { archived: "true" }, { archived: 1 }].map((value) =>
				enabled.request("thread/search", {
					searchTerm: "needle",
					sourceKinds: ["appServer"],
					...value,
				}),
			),
		);
		const updated = resultRecord(
			await enabled.request("thread/search", {
				searchTerm: "recency probe",
				sourceKinds: ["appServer"],
				sortKey: "updated_at",
			}),
			"thread/search updated_at",
		);
		const recency = resultRecord(
			await enabled.request("thread/search", {
				searchTerm: "recency probe",
				sourceKinds: ["appServer"],
				sortKey: "recency_at",
			}),
			"thread/search recency_at",
		);

		const emptyCode = errorCode(empty);
		const gateMessage = errorMessage(gated);
		const invalidSourceCode = errorCode(invalidSource);
		const defaultSourcesExcluded =
			arrayValue(resultRecord(defaultSearch, "thread/search default").data).length === 0 &&
			arrayValue(resultRecord(emptySourceSearch, "thread/search empty sourceKinds").data).length === 0;
		const malformedParamsRejected = malformed.every((response) => errorCode(response) === -32600);
		const searchHits = data.length;
		const snippetMatch = snippet.toLowerCase().includes("needle");
		const gateEnforced = gateMessage.includes("experimentalApi");
		const updatedFirst = firstThreadId(updated);
		const recencyFirst = firstThreadId(recency);
		const recencyDistinct = updatedFirst === assistantRecentId && recencyFirst === userRecentId;
		console.log(`SEARCH_HITS=${searchHits}`);
		console.log(`SNIPPET_MATCH=${snippetMatch ? 1 : 0}`);
		console.log(`EMPTY_TERM_CODE=${emptyCode ?? "INVALID"}`);
		console.log(`GATE_ENFORCED=${gateEnforced ? 1 : 0}`);
		console.log(`SOURCE_KIND_INVALID=${invalidSourceCode === -32600 ? 1 : 0}`);
		console.log(`DEFAULT_SOURCES_EXCLUDE_APP_SERVER=${defaultSourcesExcluded ? 1 : 0}`);
		console.log(`MALFORMED_PARAMS_REJECTED=${malformedParamsRejected ? 1 : 0}`);
		console.log(`RECENCY_DISTINCT=${recencyDistinct ? 1 : 0}`);
		if (
			searchHits < 1 ||
			!snippetMatch ||
			(emptyCode !== -32600 && emptyCode !== -32602) ||
			!gateEnforced ||
			invalidSourceCode !== -32600 ||
			!defaultSourcesExcluded ||
			!malformedParamsRejected ||
			!recencyDistinct
		) {
			throw new Error("task8 search assertions failed");
		}
	} finally {
		await Promise.all([enabled.close(), disabled.close()]);
		await rm(root, { recursive: true, force: true });
	}
}

function resultRecord(response: WireRecord, method: string): WireRecord {
	if ("error" in response) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
	return recordValue(response.result) ?? {};
}

function assertResult(response: WireRecord, method: string): void {
	if ("error" in response) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
}

function errorCode(response: WireRecord): number | null {
	const error = recordValue(response.error);
	return typeof error?.code === "number" ? error.code : null;
}

function errorMessage(response: WireRecord): string {
	const error = recordValue(response.error);
	return typeof error?.message === "string" ? error.message : "";
}

function firstThreadId(result: WireRecord): string | null {
	const first = recordValue(arrayValue(result.data)[0]);
	const thread = recordValue(first?.thread);
	return typeof thread?.id === "string" ? thread.id : null;
}

function arrayValue(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): WireRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
