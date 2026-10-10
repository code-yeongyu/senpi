import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../../src/config.ts";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

let scratch: string;
let project: string;
let agentDir: string;
let outside: string;
let harness: Harness | undefined;
const approvals: string[] = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-permission-2624-"));
	project = join(scratch, "project");
	agentDir = join(scratch, "agent");
	outside = join(scratch, "outside.txt");
	await mkdir(project);
	await mkdir(agentDir);
	await writeFile(outside, "original");
	vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
	approvals.length = 0;
});

afterEach(async () => {
	harness?.cleanup();
	harness = undefined;
	vi.unstubAllEnvs();
	await rm(scratch, { recursive: true, force: true });
});

async function openSession(scope?: "global" | "project", content?: string) {
	if (scope && content !== undefined) {
		const directory = scope === "global" ? agentDir : join(project, CONFIG_DIR_NAME);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "settings.json"), content);
	}
	harness = await createHarness({ cwd: project, extensionFactories: [permissionSystemExtension] });
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
