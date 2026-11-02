import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { expect, it, vi } from "vitest";
import { registerSessionResourceCleanup } from "../../../../ai/src/session-resources.ts";
import { ModelUsabilityBudgetError } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { getToolSearchService } from "../../../src/core/extensions/builtin/tool-search/service.ts";
import { attachMcpGrantPresentation, getMcpGrantPresentation } from "../../../src/core/mcp-grant-presentations.ts";
import { loadEntriesFromFile, SessionManager } from "../../../src/core/session-manager.ts";
import { SessionResumeConflictError } from "../../../src/core/session-resume-conflict.ts";
import { liveSessionWritePaths } from "../../../src/core/session-write-reservation.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { resumeRuntime } from "../issue-1473-runtime-support.ts";
import { getMessageText } from "../harness.ts";

// #1473: SDK rejection disposes the constructed candidate before the runtime receives a result.
it("rejects a same-file candidate without releasing the source ID or provider-scope catalog", async () => {
	const scope = new ProviderScope();
	try {
		await runWithProviderScope(scope, async () => {
			const host = await resumeRuntime(() => {}, 100_000, {
				compactionEnabled: false,
				resumeContextWindow: 1_000,
			});
			const released: Array<string | undefined> = [];
			const stopCleanup = registerSessionResourceCleanup((id) => released.push(id));
			const detach = attachMcpGrantPresentation(host.runtime.session.sessionId, async () => "source presenter");
			try {
				await host.runtime.session.prompt("persist source", { sessionTitlePrompt: false });
				const live = host.runtime.session;
				const path = live.sessionFile;
				if (!path) throw new Error("Missing source file");
				const bytes = readFileSync(path);
				const search = getToolSearchService();
				const presenter = getMcpGrantPresentation(live.sessionId);
				await expect(host.runtime.switchSession(path)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
				expect(readFileSync(path)).toEqual(bytes);
				expect(released).toEqual([]);
				expect(getMcpGrantPresentation(live.sessionId)).toBe(presenter);
				expect(await presenter?.("still live", [])).toBe("source presenter");
				expect(getToolSearchService()).toBe(search);
				expect(search.isDisposed).toBe(false);
				expect(liveSessionWritePaths().filter((p) => p === path)).toEqual([path]);
				await live.prompt("still usable", { sessionTitlePrompt: false });
				expect(live.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "follow-up" }] });
			} finally {
				detach();
				stopCleanup();
				await host.dispose();
			}
		});
	} finally {
		scope.close();
	}
}, 30_000);

// #1473: acceptance uses the one admitted generation and includes writes made by outgoing shutdown.
it("activates the admitted same-file generation with its current transcript and scope service", async () => {
	const scope = new ProviderScope();
	try {
		await runWithProviderScope(scope, async () => {
			let starts = 0;
			const host = await resumeRuntime((pi) => {
				pi.on("session_start", () => {
					starts++;
				});
				pi.on("session_shutdown", (event) => {
					if (event.reason === "resume") pi.appendEntry("shutdown-marker", { value: "retired" });
				});
			});
			try {
				await host.runtime.session.prompt("persist source", { sessionTitlePrompt: false });
				const old = host.runtime.session;
				const oldSearch = getToolSearchService();
				const path = old.sessionFile;
				if (!path) throw new Error("Missing source file");
				expect(await host.runtime.switchSession(path)).toEqual({ cancelled: false });
				const live = host.runtime.session;
				expect(live).not.toBe(old);
				expect(host.factories()).toBe(2);
				expect(starts).toBe(2);
				expect(oldSearch.isDisposed).toBe(true);
				expect(getToolSearchService()).not.toBe(oldSearch);
				expect(getToolSearchService().isDisposed).toBe(false);
				expect(live.sessionManager.getBranch()).toContainEqual(
					expect.objectContaining({ type: "custom", customType: "shutdown-marker", data: { value: "retired" } }),
				);
				expect(liveSessionWritePaths().filter((p) => p === path)).toEqual([path]);
				await live.prompt("after accepted resume", { sessionTitlePrompt: false });
				expect(live.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "follow-up" }] });
				expect(live.messages).toEqual(SessionManager.open(path).buildSessionContext().messages);
			} finally {
				await host.dispose();
			}
		});
	} finally {
		scope.close();
	}
}, 30_000);

// #1473: legacy migration and staged content may exceed the actual resident-store budget.
it("owns no writer while prepared and commits large legacy content without resident tokens", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pr1473-prepared-"));
	const path = join(cwd, "legacy.jsonl");
	const text = "legacy ".repeat(10_000_000);
	writeFileSync(
		path,
		[
			JSON.stringify({ type: "session", version: 2, id: "legacy", cwd, timestamp: new Date(0).toISOString() }),
			JSON.stringify({
				type: "message",
				id: "user",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: text, timestamp: 0 },
			}),
		].join("\n"),
	);
	const prepared = await SessionManager.prepareOpen(path);
	try {
		const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
		const before = hash(readFileSync(path));
		prepared.sessionManager.appendCustomEntry("candidate", { value: "staged" });
		expect(liveSessionWritePaths()).not.toContain(path);
		expect(hash(readFileSync(path))).toBe(before);
		expect(
			prepared.sessionManager
				.buildSessionContext()
				.messages.filter((m) => m.role === "user")
				.map((m) => hash(getMessageText(m))),
		).toEqual([hash(text)]);
		await prepared.commit();
		expect(liveSessionWritePaths().filter((p) => p === path)).toEqual([path]);
		const entries = loadEntriesFromFile(path);
		expect(
			entries.flatMap((e) =>
				e.type === "message" && e.message.role === "user" ? [hash(getMessageText(e.message))] : [],
			),
		).toEqual([hash(text)]);
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "candidate", data: { value: "staged" } }),
		);
		expect(readFileSync(path, "utf8")).not.toContain("senpi-resident-string:v1:");
		expect(prepared.sessionManager.getResidentStoreStats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	} finally {
		prepared.sessionManager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
	expect(liveSessionWritePaths()).not.toContain(path);
}, 30_000);

// #1473: rejection preserves the newest destination, not the stale snapshot used for admission.
it("rejects a changed destination before publishing its prepared writer", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pr1473-conflict-"));
	const path = join(cwd, "session.jsonl");
	writeFileSync(
		path,
		JSON.stringify({ type: "session", version: 3, id: "target", cwd, timestamp: new Date(0).toISOString() }),
	);
	const prepared = await SessionManager.prepareOpen(path);
	try {
		prepared.sessionManager.appendCustomEntry("must-not-persist", {});
		appendFileSync(path, "\n");
		const changed = readFileSync(path);
		await expect(prepared.commit()).rejects.toBeInstanceOf(SessionResumeConflictError);
		expect(readFileSync(path)).toEqual(changed);
		expect(liveSessionWritePaths()).not.toContain(path);
	} finally {
		prepared.sessionManager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #1473: equal contents do not authorize writing to a different canonical target after an await.
it("rejects a symlink retargeted to an equal-byte destination", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pr1473-alias-"));
	const first = join(cwd, "first.jsonl");
	const second = join(cwd, "second.jsonl");
	const alias = join(cwd, "alias.jsonl");
	const bytes = JSON.stringify({
		type: "session",
		version: 3,
		id: "alias",
		cwd,
		timestamp: new Date(0).toISOString(),
	});
	writeFileSync(first, bytes);
	writeFileSync(second, bytes);
	symlinkSync(first, alias);
	const prepared = await SessionManager.prepareOpen(alias);
	try {
		prepared.sessionManager.appendCustomEntry("must-not-persist", {});
		unlinkSync(alias);
		symlinkSync(second, alias);
		await expect(prepared.commit()).rejects.toBeInstanceOf(SessionResumeConflictError);
		expect(readFileSync(first, "utf8")).toBe(bytes);
		expect(readFileSync(second, "utf8")).toBe(bytes);
		expect(liveSessionWritePaths()).not.toContain(alias);
	} finally {
		prepared.sessionManager.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// #1473: the published base must describe actual bytes, not normalized in-memory entries.
it.each(["unchanged", "append", "rewrite"])(
	"serves the accepted %s transcript through its captured base",
	async (kind) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		const cwd = mkdtempSync(join(tmpdir(), "pr1473-transcript-"));
		const path = join(cwd, "session.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({
					type: "session",
					version: kind === "rewrite" ? 2 : 3,
					id: "base",
					cwd,
					timestamp: new Date(0).toISOString(),
				}),
				"",
				"malformed line skipped by the ordinary loader",
				JSON.stringify({
					type: "message",
					id: "user",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message: { role: "user", content: "original history", timestamp: 0 },
				}),
			].join("\n"),
		);
		const prepared = await SessionManager.prepareOpen(path);
		try {
			if (kind === "append") prepared.sessionManager.appendCustomEntry("candidate", { committed: true });
			await prepared.commit();
			const lane = new SessionAcceptanceLane();
			lane.bootstrap({ transcript: prepared.sessionManager.beginTranscriptJournal() });
			const transcript = lane.freeze().transcript;
			expect(transcript.base?.count).toBe(kind === "append" ? 3 : 2);
			const result = await readTranscriptRoot(transcript);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.error);
			expect(result.entries).toContainEqual(
				expect.objectContaining({
					type: "message",
					message: { role: "user", content: "original history", timestamp: 0 },
				}),
			);
			if (kind === "append")
				expect(result.entries).toContainEqual(
					expect.objectContaining({ type: "custom", customType: "candidate", data: { committed: true } }),
				);
		} finally {
			prepared.sessionManager.dispose();
			vi.unstubAllEnvs();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
