import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMcpConfig, resolveExtensionMcpServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import { resolveSkillMcpServer } from "../../src/core/extensions/builtin/mcp/skill-server.ts";
import { referenceRoot } from "../suite/regressions/3858-reference-support.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, open: vi.fn(original.open) };
});

describe("reference source admission (#3858)", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		vi.clearAllMocks();
		files = referenceRoot();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		files.close();
	});

	it.each(["remote-skill", "untrusted-skill", "extension"] as const)(
		"refuses %s objects without reference I/O",
		(source) => {
			const open = vi.spyOn(fs, "open");
			const declaration = {
				command: "fixture",
				...(source === "remote-skill" ? { type: "http", url: "https://example.invalid" } : {}),
				headers: { Authorization: { $file: join(files.root, "unread") } },
			};
			if (source === "extension") {
				expect(() =>
					Reflect.apply(resolveExtensionMcpServer, undefined, [
						"fixture",
						declaration,
						"extension.ts",
						files.root,
					]),
				).toThrow(expect.objectContaining({ name: "ConfigReferenceError", reason: "forbidden" }));
			} else {
				const resolved = Reflect.apply(resolveSkillMcpServer, undefined, [
					"fixture",
					declaration,
					join(files.root, "SKILL.md"),
					{ skillName: "fixture", trusted: source === "remote-skill" },
				]);
				expect(resolved.server).toBeUndefined();
				expect(resolved.warning).toContain("forbidden");
			}
			expect(open).not.toHaveBeenCalled();
		},
	);

	it("keeps trusted Claude references raw until the connection generation", () => {
		files.file("mcp.json", JSON.stringify({ settings: { importConfigs: ["claude"] } }));
		const ref = { $file: join(files.root, "unread") };
		files.file(".mcp.json", JSON.stringify({ mcpServers: { fixture: { command: "fixture", args: [ref] } } }));
		const open = vi.spyOn(fs, "open");
		const config = loadMcpConfig({ agentDir: files.root, cwd: files.root, projectTrusted: true });
		expect(config.servers.fixture?.source).toBe("claude");
		expect(open).not.toHaveBeenCalled();
	});

	it("keeps untrusted Claude declarations as name-only placeholders", () => {
		files.file("mcp.json", JSON.stringify({ settings: { importConfigs: ["claude"] } }));
		files.file(
			".mcp.json",
			JSON.stringify({ mcpServers: { fixture: { command: "fixture", args: [{ $file: "unread" }] } } }),
		);
		const open = vi.spyOn(fs, "open");
		const config = loadMcpConfig({ agentDir: files.root, cwd: files.root, projectTrusted: false });
		expect(config.servers.fixture).toMatchObject({ state: "untrusted" });
		expect(config.servers.fixture?.config).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
	});
});
