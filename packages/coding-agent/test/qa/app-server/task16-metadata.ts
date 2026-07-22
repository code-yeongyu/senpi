import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createHarnessForRoot,
	objectAt,
	responseResult,
	threadIdFromResponse,
} from "../../suite/app-server-thread-handlers-harness.ts";

const root = await mkdtemp(join(tmpdir(), "senpi-task16-metadata-"));
const harness = createHarnessForRoot(root);

try {
	const threadId = threadIdFromResponse(
		await harness.registry.dispatch(harness.connection, {
			id: 1,
			method: "thread/start",
			params: { cwd: root },
		}),
	);
	const created = await harness.registry.dispatch(harness.connection, {
		id: 2,
		method: "thread/metadata/update",
		params: {
			threadId,
			gitInfo: { sha: " sha-1 ", branch: " main ", originUrl: " https://example.test/repo.git " },
		},
	});
	const patched = await harness.registry.dispatch(harness.connection, {
		id: 3,
		method: "thread/metadata/update",
		params: { threadId, gitInfo: { branch: null } },
	});
	const createdGitInfo = objectAt(objectAt(responseResult(created), "thread"), "gitInfo");
	const patchedGitInfo = objectAt(objectAt(responseResult(patched), "thread"), "gitInfo");
	const triState =
		createdGitInfo.sha === "sha-1" &&
		createdGitInfo.branch === "main" &&
		createdGitInfo.originUrl === "https://example.test/repo.git" &&
		patchedGitInfo.sha === "sha-1" &&
		patchedGitInfo.branch === null &&
		patchedGitInfo.originUrl === "https://example.test/repo.git"
			? 1
			: 0;

	await harness.registry.dispatch(harness.connection, {
		id: 4,
		method: "thread/archive",
		params: { threadId },
	});
	const archivedUpdate = await harness.registry.dispatch(harness.connection, {
		id: 5,
		method: "thread/metadata/update",
		params: { threadId, gitInfo: { branch: " archived " } },
	});
	const archivedThread = objectAt(responseResult(archivedUpdate), "thread");
	const archivedUpdateOk =
		JSON.stringify(archivedThread.status) === JSON.stringify({ type: "notLoaded" }) &&
		objectAt(archivedThread, "gitInfo").branch === "archived" &&
		(() => {
			try {
				harness.threads.getLoadedThread(threadId);
				return 0;
			} catch (error) {
				if (error instanceof Error) return 1;
				throw error;
			}
		})();

	const empty = await harness.registry.dispatch(harness.connection, {
		id: 6,
		method: "thread/metadata/update",
		params: { threadId, gitInfo: { branch: " \t" } },
	});
	const emptyRejected =
		"error" in empty && empty.error.code === -32600 && empty.error.message === "gitInfo.branch must not be empty"
			? 1
			: 0;

	console.log(`TRISTATE_OK=${triState}`);
	console.log(`ARCHIVED_UPDATE=${archivedUpdateOk}`);
	console.log(`EMPTY_REJECTED=${emptyRejected}`);
	console.log("EXIT=0");
	if (triState !== 1 || archivedUpdateOk !== 1 || emptyRejected !== 1) {
		throw new Error("task16 metadata assertions failed");
	}
} finally {
	harness.lifecycle.dispose();
	await rm(root, { recursive: true, force: true });
}
