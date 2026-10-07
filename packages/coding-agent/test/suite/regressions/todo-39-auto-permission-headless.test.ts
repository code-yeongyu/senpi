import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createBashTool } from "../../../src/core/tools/bash.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function headless(flags: ReadonlyArray<readonly [string, string]>, command: string) {
	const harness = await createHarness({
		tools: [createBashTool(process.cwd())],
		extensionFactories: [permissionSystemExtension],
		extensionFlagValues: new Map(flags),
	});
	harnesses.push(harness);
	writeFileSync(join(harness.tempDir, "notes.txt"), "keep me\n");
	await harness.session.bindExtensions({});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: `cd ${harness.tempDir} && ${command}` }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("continued"),
	]);
	await harness.session.prompt("tidy up");
	return { harness, result: getMessageText(getToolResult(harness, "bash")) };
}

describe("auto permission preset with no UI to ask (print mode, unbound SDK)", () => {
	it.each([
		["with no rule of the user's", []],
		["with --permission bash=allow", [["permission", "bash=allow"]]],
	] as const)(
		"refuses what auto asks for %s, and the turn goes on",
		async (_label, extra) => {
			// Given an auto session with no approver, optionally with a user allow for every command.
			// When the agent deletes a file, which auto asks for.
			const { harness, result } = await headless([["permission-preset", "auto"], ...extra], "rm notes.txt");
			// Then the call is refused at once with a reason, the file stays, and the turn continues.
			expect(result).toContain("Permission required for bash");
			expect(result).not.toContain("--permission bash=allow");
			expect(readFileSync(join(harness.tempDir, "notes.txt"), "utf8")).toBe("keep me\n");
			expect(existsSync(join(harness.tempDir, "notes.txt"))).toBe(true);
		},
		30_000,
	);

	it.each([
		["the allowed path first", true],
		["the allowed path last", false],
	] as const)(
		"outside auto, refuses a call with one path no rule allows: %s",
		async (_label, allowedFirst) => {
			// Given the ask preset, a user allow for one outside folder, and no approver.
			const safe = mkdtempSync(join(tmpdir(), "auto-noui-safe-"));
			const other = mkdtempSync(join(tmpdir(), "auto-noui-other-"));
			writeFileSync(join(safe, "a.txt"), "SAFE-CONTENT\n");
			writeFileSync(join(other, "b.txt"), "OTHER-CONTENT\n");
			try {
				// When the agent reads a file there together with a file from a folder no rule allows.
				const { result } = await headless(
					[
						["permission-preset", "ask"],
						["permission", `bash=allow,external_directory:${safe}/*=allow`],
					],
					allowedFirst
						? `cat ${join(safe, "a.txt")} ${join(other, "b.txt")}`
						: `cat ${join(other, "b.txt")} ${join(safe, "a.txt")}`,
				);
				// Then the call is refused at once and nothing of the other folder is read.
				expect(result).not.toContain("OTHER-CONTENT");
				expect(result).toMatch(/Permission (required|denied)/);
			} finally {
				rmSync(safe, { recursive: true, force: true });
				rmSync(other, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
