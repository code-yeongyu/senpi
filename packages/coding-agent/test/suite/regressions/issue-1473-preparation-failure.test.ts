import type * as FsPromises from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionResumeConflictError, SessionResumeRejectedError } from "../../../src/core/session-resume-conflict.ts";
import { getToolSearchService } from "../../../src/core/extensions/builtin/tool-search/service.ts";
import { liveSessionWritePaths } from "../../../src/core/session-write-reservation.ts";
import { deadline, resumeRuntime } from "../issue-1473-runtime-support.ts";

// The filesystem is real; only the OS failure is injected, following session-manager/atomic-rewrite.
const disk = vi.hoisted(() => {
	const state: {
		partialWrite: boolean;
		directorySync: boolean;
		staged?: () => Promise<void>;
		published?: () => Promise<void>;
	} = { partialWrite: false, directorySync: false };
	const wrap = (actual: typeof FsPromises): typeof FsPromises => ({
		...actual,
		open: async (...args) => {
			const handle = await actual.open(...args);
			const write = handle.writeFile.bind(handle);
			const sync = handle.sync.bind(handle);
			handle.writeFile = async (data, options) => {
				if (String(args[0]).endsWith(".tmp")) {
					await state.staged?.();
					if (state.partialWrite) {
						state.partialWrite = false;
						await write("partial");
						throw Object.assign(new Error("ENOSPC: staged publication"), { code: "ENOSPC" });
					}
				}
				return write(data, options);
			};
			handle.sync = async () => {
				if ((await handle.stat()).isDirectory()) {
					await state.published?.();
					if (state.directorySync) {
						state.directorySync = false;
						throw Object.assign(new Error("EIO: directory sync after publication"), { code: "EIO" });
					}
				}
				return sync();
			};
			return handle;
		},
	});
	return { state, wrap };
});
vi.mock("fs/promises", async (original) => disk.wrap(await original<typeof FsPromises>()));
vi.mock("node:fs/promises", async (original) => disk.wrap(await original<typeof FsPromises>()));

// #1473: either side of the atomic publication boundary must leave a usable source writer.
it.each(["partial-write", "directory-sync"])(
	"same-file %s failure retains a safely appendable source",
	async (failure) => {
		const host = await resumeRuntime(() => {}, undefined, {
			afterCreate: (session) => {
				session.sessionManager.appendCustomEntry("candidate", { staged: true });
				disk.state.partialWrite = failure === "partial-write";
				disk.state.directorySync = failure === "directory-sync";
			},
		});
		try {
			await host.runtime.session.prompt("source", { sessionTitlePrompt: false });
			const live = host.runtime.session;
			const path = live.sessionFile;
			if (!path) throw new Error("Missing source file");
			const before = readFileSync(path);
			await expect(host.runtime.switchSession(path)).rejects.toBeInstanceOf(SessionResumeRejectedError);
			expect(host.runtime.session).toBe(live);
			if (failure === "partial-write") expect(readFileSync(path)).toEqual(before);
			else
				expect(live.sessionManager.getBranch()).toContainEqual(
					expect.objectContaining({ type: "custom", customType: "candidate", data: { staged: true } }),
				);
			expect(liveSessionWritePaths().filter((p) => p === path)).toEqual([path]);
			await live.prompt("source survives", { sessionTitlePrompt: false });
			expect(live.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "follow-up" }] });
			expect(live.messages).toEqual(SessionManager.open(path).buildSessionContext().messages);
		} finally {
			disk.state.partialWrite = false;
			disk.state.directorySync = false;
			await host.dispose();
		}
	},
	30_000,
);

// #1473: asynchronous publication must keep both the grant and the source's next append safe.
it.each([
	{ stage: "staged", sameFile: true },
	{ stage: "staged", sameFile: false },
	{ stage: "published", sameFile: true },
] as const)(
	"retains publication ownership during $stage (same file: $sameFile)",
	async ({ stage, sameFile }) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const host = await resumeRuntime(() => {}, undefined, {
			afterCreate: (session) => {
				session.sessionManager.appendCustomEntry("candidate", { staged: true });
				disk.state[stage] = async () => {
					disk.state[stage] = undefined;
					entered.resolve();
					await release.promise;
				};
			},
		});
		let outcome: Promise<unknown> | undefined;
		try {
			await host.runtime.session.prompt("source", { sessionTitlePrompt: false });
			const source = host.runtime.session;
			const sourcePath = source.sessionFile;
			if (!sourcePath) throw new Error("Missing source file");
			const path = sameFile ? sourcePath : join(host.cwd, "destination.jsonl");
			if (!sameFile) writeFileSync(path, readFileSync(sourcePath));
			const bytes = readFileSync(path);
			outcome = host.runtime.switchSession(path).catch((error: unknown) => error);
			await deadline(entered.promise);
			// A snapshot sent while I/O is pending must not release the candidate's host grant.
			expect(liveSessionWritePaths()).toContain(path);
			expect(() => SessionManager.open(path)).toThrow(SessionResumeConflictError);
			if (sameFile)
				expect(() => source.sessionManager.appendCustomEntry("concurrent-write", {})).toThrow(
					SessionResumeConflictError,
				);
			else source.sessionManager.appendCustomEntry("independent-source-write", {});
			host.runtime.setPromptSurface("chat");
			release.resolve();
			expect(await deadline(outcome)).toBeInstanceOf(SessionResumeRejectedError);
			expect(host.runtime.session).toBe(source);
			if (stage === "staged") expect(readFileSync(path)).toEqual(bytes);
			else
				expect(source.sessionManager.getBranch()).toContainEqual(
					expect.objectContaining({ type: "custom", customType: "candidate", data: { staged: true } }),
				);
			expect(liveSessionWritePaths().filter((p) => p === path)).toEqual(sameFile ? [path] : []);
			await source.prompt("source survives", { sessionTitlePrompt: false });
			expect(source.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "follow-up" }] });
			expect(source.messages).toEqual(SessionManager.open(sourcePath).buildSessionContext().messages);
		} finally {
			release.resolve();
			if (outcome) await outcome;
			disk.state.staged = undefined;
			disk.state.published = undefined;
			await host.dispose();
		}
	},
	30_000,
);

// #1473: the production in-process host passes the same ModelRuntime into every factory.
it("keeps candidate provider registration and settings off the shared source runtime", async () => {
	const shared = ModelRuntime.createSync({ modelsPath: null, credentials: AuthStorage.inMemory() });
	let candidateRuntime: ModelRuntime | undefined;
	const host = await resumeRuntime(() => {}, 100_000, {
		modelRuntime: shared,
		resumeContextWindow: 1_000,
		compactionEnabled: false,
		configureServices: (services, candidate) => {
			if (!candidate) return;
			candidateRuntime = services.modelRuntime;
			void services.modelRuntime.registerProvider(
				"candidate-only",
				{
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:1",
					apiKey: "synthetic",
					models: [
						{
							id: "candidate",
							name: "Candidate",
							contextWindow: 100_000,
							maxTokens: 4_000,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
				{ refresh: false },
			);
			services.settingsManager.applyOverrides({ defaultProvider: "candidate-only" });
		},
	});
	try {
		await host.runtime.session.prompt("source", { sessionTitlePrompt: false });
		const source = host.runtime.session;
		const path = source.sessionFile;
		if (!path) throw new Error("Missing source file");
		await expect(host.runtime.switchSession(path)).rejects.toMatchObject({ name: "ModelUsabilityBudgetError" });
		expect(candidateRuntime).not.toBe(shared);
		expect(candidateRuntime?.getModel("candidate-only", "candidate")).toBeDefined();
		expect(shared.getModel("candidate-only", "candidate")).toBeUndefined();
		expect(host.runtime.services.modelRuntime).toBe(shared);
		expect(source.settingsManager.getDefaultProvider()).not.toBe("candidate-only");
		await source.prompt("source provider survives", { sessionTitlePrompt: false });
		expect(source.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "follow-up" }] });
	} finally {
		await host.dispose();
		shared.dispose();
	}
}, 30_000);

// #1473: the factory may throw after the SDK has successfully constructed its session.
it.each(["factory-error", "profile-change", "config-file-change"])(
	"discards the candidate after %s without retiring its source",
	async (kind) => {
		let sourceHost: Awaited<ReturnType<typeof resumeRuntime>> | undefined;
		const host = await resumeRuntime(() => {}, undefined, {
			afterCreate: (session) => {
				session.sessionManager.appendCustomEntry("must-not-persist", {});
				if (kind === "profile-change") sourceHost?.runtime.setPromptSurface("chat");
				else if (kind === "config-file-change" && sourceHost)
					writeFileSync(join(sourceHost.cwd, "models.json"), "{}");
				else throw new Error("factory failed after SDK construction");
			},
		});
		sourceHost = host;
		try {
			await host.runtime.session.prompt("source", { sessionTitlePrompt: false });
			const live = host.runtime.session;
			const search = getToolSearchService();
			const path = live.sessionFile;
			if (!path) throw new Error("Missing source file");
			const bytes = readFileSync(path);
			await expect(host.runtime.switchSession(path)).rejects.toBeInstanceOf(SessionResumeRejectedError);
			expect(readFileSync(path)).toEqual(bytes);
			expect(host.runtime.session).toBe(live);
			expect(getToolSearchService()).toBe(search);
			expect(search.isDisposed).toBe(false);
			expect(liveSessionWritePaths().filter((p) => p === path)).toEqual([path]);
			await live.prompt("source survives", { sessionTitlePrompt: false });
			expect(live.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "follow-up" }] });
		} finally {
			await host.dispose();
		}
	},
	30_000,
);
