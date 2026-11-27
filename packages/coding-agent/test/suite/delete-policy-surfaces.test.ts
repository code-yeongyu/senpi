// omo#11072: the deletePolicy setting, the `trash` tool a model calls, and the `senpi trash` CLI a user runs.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTrashCommand } from "../../src/cli/trash-command.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { resolveDeletePolicy } from "../../src/core/extensions/builtin/delete-policy/policy.ts";
import { TRASH_TOOL, type TrashToolDetails } from "../../src/core/extensions/builtin/delete-policy/tool.ts";
import { listTrash, trashPath } from "../../src/core/extensions/builtin/delete-policy/trash.ts";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";
import { createTestResourceLoader } from "../utilities.ts";
import {
	auditRows,
	readTree,
	removeTrashSandboxes,
	type TrashSandbox,
	trashSandbox,
	writeTree,
} from "./delete-policy-fixtures.ts";
import { createHarness, type Harness } from "./harness.ts";

const EXTENSION_PATH = fileURLToPath(
	new URL("../../src/core/extensions/builtin/delete-policy/index.ts", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await removeTrashSandboxes();
});

function pointHomeAt(box: TrashSandbox): void {
	vi.stubEnv("HOME", box.home);
	vi.stubEnv("XDG_DATA_HOME", join(box.home, ".local", "share"));
	vi.stubEnv("SENPI_CODING_AGENT_DIR", box.agentDir);
}

describe("deletePolicy setting", () => {
	it.each([
		["no setting, no CI", {}, {}, { mode: "trash", retentionDays: 14, maxTrashBytes: "auto" }],
		[
			"CI=true defaults to log-only",
			{},
			{ CI: "true" },
			{ mode: "log-only", retentionDays: 14, maxTrashBytes: "auto" },
		],
		[
			"an explicit mode wins over CI",
			{ deletePolicy: { mode: "trash-only", retentionDays: 3, maxTrashBytes: 4096 } },
			{ CI: "true" },
			{ mode: "trash-only", retentionDays: 3, maxTrashBytes: 4096 },
		],
	])("%s", (_name, settings, env, expected) => {
		expect(resolveDeletePolicy(settings, env)).toEqual(expected);
	});

	it.each([
		[{ deletePolicy: "trash" }],
		[{ deletePolicy: { mode: "rm" } }],
		[{ deletePolicy: { retentionDays: 0 } }],
		[{ deletePolicy: { maxTrashBytes: "lots" } }],
	])("rejects %j", (settings) => {
		expect(() => resolveDeletePolicy(settings, {})).toThrow(/Invalid deletePolicy setting/);
	});
});

describe.skipIf(process.platform === "win32")("trash tool", () => {
	it("is a builtin, so every session can trash instead of deleting", () => {
		expect(builtinExtensions.map((extension) => extension.id)).toContain("delete-policy");
	});

	it("moves each path to the trash through a model tool call and reports the restore id", async () => {
		const box = await trashSandbox();
		pointHomeAt(box);
		const target = join(box.work, "worktree-1");
		await writeTree(target, { "file.txt": "data" });
		const extensionsResult = await discoverAndLoadExtensions([EXTENSION_PATH], REPO_ROOT, REPO_ROOT);
		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall(TRASH_TOOL, { paths: [target, join(box.work, "missing")], reason: "merged" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("clean up");

		const result = harness.session.messages.find((m) => m.role === "toolResult" && m.toolName === TRASH_TOOL);
		if (result?.role !== "toolResult") throw new Error("expected a trash tool result");
		const { outcomes } = result.details as unknown as TrashToolDetails;
		expect(outcomes.map((outcome) => outcome.kind)).toEqual(["trashed", "refused"]);
		const trashed = outcomes[0];
		if (trashed?.kind !== "trashed") throw new Error("expected the first path trashed");
		expect(trashed.entry).toMatchObject({ originalPath: target, sessionId: harness.sessionManager.getSessionId() });
		await expect(readdir(box.work)).resolves.toEqual([]);
		await expect(readTree(trashed.entry.trashedPath)).resolves.toEqual({ "file.txt": "data" });
	});
});

describe.skipIf(process.platform === "win32")("senpi trash CLI", () => {
	async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const out: string[] = [];
		const err: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => out.push(String(chunk)) > 0);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => err.push(String(chunk)) > 0);
		const code = await runTrashCommand(args);
		vi.restoreAllMocks();
		return { code, stdout: out.join(""), stderr: err.join("") };
	}

	it("lists, restores and empties what the trash holds; empty is audited as the user", async () => {
		const box = await trashSandbox();
		pointHomeAt(box);
		await writeTree(box.work, { "a/f": "1", "b/f": "2" });
		const a = await trashPath(box.scope(), join(box.work, "a"), "x");
		const b = await trashPath(box.scope(), join(box.work, "b"), "x");

		const listed = await cli(["list", "--json"]);
		expect(listed.code).toBe(0);
		expect(JSON.parse(listed.stdout)).toEqual(await listTrash(box.scope()));

		await expect(cli(["restore", a.id])).resolves.toMatchObject({ code: 0 });
		await expect(readTree(join(box.work, "a"))).resolves.toEqual({ f: "1" });

		await expect(cli(["empty", "--all"])).resolves.toMatchObject({ code: 0 });
		await expect(listTrash(box.scope())).resolves.toEqual([]);
		await expect(auditRows(box.agentDir)).resolves.toEqual([
			expect.objectContaining({ actor: "user", sessionId: null, path: b.originalPath, trashId: b.id }),
		]);
	});

	it("exits 2 on a usage error and 1 on a refusal", async () => {
		const box = await trashSandbox();
		pointHomeAt(box);

		await expect(cli(["empty", "--older-than", "soon"])).resolves.toMatchObject({ code: 2 });
		await expect(cli(["shred"])).resolves.toMatchObject({ code: 2 });
		const missing = await cli(["restore", "tr_0_00000000"]);
		expect(missing).toMatchObject({ code: 1, stdout: "" });
		expect(missing.stderr).toContain("No trash entry tr_0_00000000");
	});
});
