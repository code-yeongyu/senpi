import { describe, expect, it } from "vitest";
import { createRepositoryIdentityExtension } from "../../../src/core/extensions/builtin/repository-identity.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { type GitRunner, REPOSITORY_IDENTITY_ENTRY_TYPE } from "../../../src/core/repository-identity.ts";

const ROOT = "f".repeat(40);

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Fixture {
	readonly appended: Array<{ customType: string; data: unknown }>;
	readonly start: (options?: { sessionFile?: string; entries?: unknown[] }) => Promise<unknown>;
	readonly shutdown: () => unknown;
}

function fixture(run: GitRunner): Fixture {
	const handlers = new Map<string, Handler>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
	};
	createRepositoryIdentityExtension(run)(pi as unknown as ExtensionAPI);
	return {
		appended,
		start: async ({ sessionFile = "/sessions/s.jsonl", entries = [] } = {}) => {
			const ctx = {
				cwd: "/work/repo",
				sessionManager: { getSessionFile: () => sessionFile || undefined, getEntries: () => entries },
			};
			return handlers.get("session_start")?.(
				{ type: "session_start", reason: "startup" },
				ctx as unknown as ExtensionContext,
			);
		},
		shutdown: () => handlers.get("session_shutdown")?.({ type: "session_shutdown" }, {} as ExtensionContext),
	};
}

const gitRepo: GitRunner = async (_dir, args) => (args[0] === "rev-list" ? `${ROOT}\n` : undefined);

describe("issue #2181 recording a session's repository", () => {
	it("records the repository once per session", async () => {
		const extension = fixture(gitRepo);

		await extension.start();
		await extension.start({
			entries: [{ type: "custom", customType: REPOSITORY_IDENTITY_ENTRY_TYPE, data: { rootCommits: [ROOT] } }],
		});

		expect(extension.appended).toEqual([
			{ customType: REPOSITORY_IDENTITY_ENTRY_TYPE, data: { rootCommits: [ROOT] } },
		]);
	});

	it("records nothing for an in-memory session or outside a repository", async () => {
		const inMemory = fixture(gitRepo);
		await inMemory.start({ sessionFile: "" });
		const notARepo = fixture(async () => undefined);
		await notARepo.start();

		expect(inMemory.appended).toEqual([]);
		expect(notARepo.appended).toEqual([]);
	});

	it("drops a lookup that finishes after its session has ended", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const extension = fixture(async (dir, args) => {
			await gate;
			return gitRepo(dir, args);
		});

		const pending = extension.start();
		extension.shutdown();
		release?.();
		await pending;

		expect(extension.appended).toEqual([]);
	});
});
