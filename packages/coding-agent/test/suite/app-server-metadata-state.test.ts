import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadArchiveState } from "../../src/modes/app-server/threads/archive-state.ts";
import {
	mergeGitInfo,
	parseGitInfoUpdate,
	ThreadMetadataState,
} from "../../src/modes/app-server/threads/metadata-state.ts";
import type { WireThread } from "../../src/modes/app-server/threads/registry.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";
import { buildWireThread } from "../../src/modes/app-server/threads/wire-thread.ts";

describe("app-server thread metadata state", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		const paths = [...tempDirs.splice(0), ...tempDirsForTests.splice(0)];
		await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
	});

	it("defaults a missing metadata sidecar to outer null gitInfo", async () => {
		// Given: a thread whose metadata sidecar does not exist.
		const { state, thread } = await createFixture();

		// When: metadata is read.
		const gitInfo = await state.readGitInfo(thread);

		// Then: the wire contract reports that no Git metadata record exists.
		expect(gitInfo).toBeNull();
	});

	it("merges omitted, null, and trimmed replacement fields with tri-state semantics", () => {
		// Given: existing metadata and a patch containing all three field forms.
		const current = { sha: "old-sha", branch: "main", originUrl: "https://old.example" };

		// When: the nested gitInfo patch is merged.
		const merged = mergeGitInfo(current, { sha: "  new-sha  ", branch: null });

		// Then: values replace after trimming, null clears, and omission keeps the old value.
		expect(merged).toEqual({ sha: "new-sha", branch: null, originUrl: "https://old.example" });
	});

	it("rejects an empty replacement after trimming", () => {
		// Given: an otherwise valid gitInfo patch with a whitespace-only replacement.
		const current = { sha: null, branch: null, originUrl: null };

		// When/Then: merging the patch rejects the empty replacement.
		expect(() => mergeGitInfo(current, { branch: " \t" })).toThrow(/branch/);
	});

	it.each([undefined, null, {}])("rejects absent, null, or empty outer gitInfo updates (%s)", (update) => {
		// Given: a request whose outer gitInfo update carries no nested field.

		// When/Then: parsing the request rejects it with the Codex invalid-request reason.
		expect(() => parseGitInfoUpdate(update)).toThrow("gitInfo must include at least one field");
	});

	it("creates nested Git metadata when no stored record exists", () => {
		// Given: no existing Git metadata record.

		// When: one nested field is supplied.
		const merged = mergeGitInfo(null, { branch: "  main  " });

		// Then: the outer record is created and unspecified nested fields are null.
		expect(merged).toEqual({ sha: null, branch: "main", originUrl: null });
	});

	it("writes and reloads metadata through the atomic sidecar path", async () => {
		// Given: a thread with no metadata sidecar.
		const { state, thread } = await createFixture();

		// When: git metadata is updated and read back.
		await state.updateGitInfo(thread, {
			sha: "  abc123  ",
			branch: " feature/parity ",
			originUrl: " https://example.test/repo.git ",
		});
		const reloaded = await new ThreadMetadataState().readGitInfo(thread);

		// Then: trimmed values survive reload and the persisted JSON is complete and parseable.
		expect(reloaded).toEqual({
			sha: "abc123",
			branch: "feature/parity",
			originUrl: "https://example.test/repo.git",
		});
		expect(JSON.parse(await readFile(`${thread.sessionPath}.metadata.json`, "utf8"))).toEqual({
			gitInfo: {
				sha: "abc123",
				branch: "feature/parity",
				originUrl: "https://example.test/repo.git",
			},
		});
	});

	it("clears every nested field while preserving the outer gitInfo record", async () => {
		// Given: a thread with stored git metadata.
		const { state, thread } = await createFixture();
		await state.updateGitInfo(thread, { sha: "abc", branch: "main", originUrl: "https://example.test/repo.git" });

		// When: every nested field is explicitly cleared.
		const cleared = await state.updateGitInfo(thread, { sha: null, branch: null, originUrl: null });

		// Then: the outer record remains present with nullable nested fields.
		expect(cleared).toEqual({ sha: null, branch: null, originUrl: null });
		expect(await state.readGitInfo(thread)).toEqual(cleared);
	});

	it("surfaces stored gitInfo when building a wire thread", async () => {
		// Given: a thread whose metadata sidecar contains a branch and commit.
		const { state, thread } = await createFixture();
		await state.updateGitInfo(thread, { sha: "abc123", branch: "main" });

		// When: the existing wire-thread projection is built.
		const wireThread = await buildWireThread(thread, new TurnLog(), false);

		// Then: the generated Thread exposes the persisted metadata.
		expect(wireThread.gitInfo).toEqual({ sha: "abc123", branch: "main", originUrl: null });
	});

	it("serializes archive and metadata mutations for one thread without losing either sidecar", async () => {
		// Given: one thread and shared archive/metadata state operating on its sidecars.
		const { state, thread, sessionDir } = await createFixture();
		const archive = new ThreadArchiveState(sessionDir);

		// When: archive/unarchive and metadata updates are issued concurrently in call order.
		await Promise.all([
			archive.markArchived(thread),
			state.updateGitInfo(thread, { sha: "sha-1", branch: "main" }),
			archive.clearArchived(thread.id),
			state.updateGitInfo(thread, { branch: " feature/final " }),
			archive.markArchived(thread),
			state.updateGitInfo(thread, { originUrl: " https://example.test/final.git " }),
		]);

		// Then: the queue leaves the last archive and every metadata field intact.
		expect(await archive.isArchived(thread)).toBe(true);
		expect(await state.readGitInfo(thread)).toEqual({
			sha: "sha-1",
			branch: "feature/final",
			originUrl: "https://example.test/final.git",
		});
	});
});

async function createFixture(): Promise<{
	readonly state: ThreadMetadataState;
	readonly thread: WireThread;
	readonly sessionDir: string;
}> {
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-metadata-state-"));
	tempDirsForTests.push(sessionDir);
	const thread: WireThread = {
		id: "thread-1",
		sessionId: "session-1",
		sessionPath: join(sessionDir, "session-1.jsonl"),
		cwd: sessionDir,
		createdAt: "2026-07-19T00:00:00.000Z",
		updatedAt: "2026-07-19T00:00:00.000Z",
		status: { type: "idle" },
		preview: null,
		name: null,
	};
	return { state: new ThreadMetadataState(), thread, sessionDir };
}

const tempDirsForTests: string[] = [];
