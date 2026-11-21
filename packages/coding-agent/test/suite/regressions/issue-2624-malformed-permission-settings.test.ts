import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../../src/config.ts";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

let scratch: string;
let project: string;
let outside: string;
let harness: Harness | undefined;
const approvals: string[] = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-permission-2624-"));
	project = join(scratch, "project");
	outside = join(scratch, "outside.txt");
	await mkdir(project);
	await writeFile(outside, "original");
	approvals.length = 0;
});

afterEach(async () => {
	harness?.cleanup();
	harness = undefined;
	await rm(scratch, { recursive: true, force: true });
});

async function openSession(scope?: "global" | "project", content?: string) {
	// Global settings come from the session's own harness-owned agentDir, reachable only through `fileSettings`.
	const globalSettings = scope === "global" && content !== undefined;
	if (scope === "project" && content !== undefined) {
		const directory = join(project, CONFIG_DIR_NAME);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "settings.json"), content);
	}
	harness = await createHarness({
		cwd: project,
		extensionFactories: [permissionSystemExtension],
		...(globalSettings ? { fileSettings: true, settingsContent: content } : {}),
	});
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			select: async (title) => {
				approvals.push(title);
				return "Deny";
			},
		}),
	});
	return harness.session;
}

describe("malformed permission settings fail closed (#2624)", () => {
	it.each(["global", "project"] as const)("blocks writes after a %s settings parse error", async (scope) => {
		const session = await openSession(scope, '{"permissionPreset":"ask","theme":}');
		await expect(session.executeTool("write", { path: outside, content: "overwritten" })).rejects.toThrow(
			"Permission setup failed",
		);
		expect(approvals).toEqual([]);
		expect(await readFile(outside, "utf8")).toBe("original");
	});

	it.each(["global", "project"] as const)("accepts valid %s JSONC without discarding its policy", async (scope) => {
		const session = await openSession(scope, '{\n// accepted JSONC\n"permissionPreset":"ask",\n}');
		await expect(session.executeTool("write", { path: outside, content: "overwritten" })).rejects.toThrow(
			"rejected permission",
		);
		expect(approvals).toHaveLength(1);
		expect(await readFile(outside, "utf8")).toBe("original");
	});

	it("keeps the full-access default when both settings files are absent", async () => {
		const session = await openSession();
		await session.executeTool("write", { path: outside, content: "overwritten" });
		expect(approvals).toEqual([]);
		expect(await readFile(outside, "utf8")).toBe("overwritten");
	});
});
