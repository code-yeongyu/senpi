import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activeBunSkillPath,
	bundledBunSkillPath,
	bunVersionSupportsSkill,
	createBunSkillDiscoverHandler,
	registerBunSkillContribution,
} from "../src/extension/skill-contribution.ts";

const bunSkillMd = join(import.meta.dirname, "..", "src", "skill", "bun-1-4", "SKILL.md");
const bunSkillRefs = join(import.meta.dirname, "..", "src", "skill", "bun-1-4", "references");

describe("bunVersionSupportsSkill", () => {
	it.each([
		{ version: "1.4.0", expected: true },
		{ version: "1.4.1", expected: true },
		{ version: "2.0.0", expected: true },
		{ version: "1.3.9", expected: false },
		{ version: "0.9.0", expected: false },
		{ version: undefined, expected: false },
		{ version: "garbage", expected: false },
	])("maps $version to $expected", ({ version, expected }) => {
		expect(bunVersionSupportsSkill(version)).toBe(expected);
	});
});

describe("bundledBunSkillPath", () => {
	it("returns the absolute bun-1-4 SKILL.md path that exists on disk", () => {
		const result = bundledBunSkillPath();
		expect(result).toBe(bunSkillMd);
		expect(result !== undefined && existsSync(result)).toBe(true);
	});
});

describe("activeBunSkillPath", () => {
	it("returns the bundled SKILL.md path on a bun >= 1.4 kernel", () => {
		expect(activeBunSkillPath(() => "1.4.2")).toBe(bunSkillMd);
	});

	it.each([{ version: "1.3.0" }, { version: undefined }, { version: "not-a-version" }])(
		"returns undefined for kernel version $version",
		({ version }) => {
			expect(activeBunSkillPath(() => version)).toBeUndefined();
		},
	);
});

describe("bundledBunSkillPath in a compiled-binary layout", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir !== undefined) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("resolves the sidecar skill next to the executable when the embedded path is absent", () => {
		tempDir = mkdtempSync(join(tmpdir(), "codemode-skill-sidecar-"));
		const binaryDir = join(tempDir, "bin");
		const sidecarSkill = join(
			binaryDir,
			"node_modules",
			"@code-yeongyu",
			"senpi-codemode",
			"src",
			"skill",
			"bun-1-4",
			"SKILL.md",
		);
		mkdirSync(dirname(sidecarSkill), { recursive: true });
		writeFileSync(sidecarSkill, "---\nname: bun-1-4\n---\n# Bun 1.4\n");

		const result = bundledBunSkillPath(join(tempDir, "embedded", "extension"), {
			bunVersion: "1.4.0",
			executablePath: join(binaryDir, "pi"),
		});

		expect(result).toBe(sidecarSkill);
	});

	it("reports a missing skill on stderr so RPC stdout stays protocol-clean", async () => {
		vi.resetModules();
		const fresh = await import("../src/extension/skill-contribution.ts");
		tempDir = mkdtempSync(join(tmpdir(), "codemode-skill-missing-"));
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const result = fresh.bundledBunSkillPath(join(tempDir, "embedded", "extension"), {
				bunVersion: "1.4.0",
				executablePath: join(tempDir, "bin", "pi"),
			});

			expect(result).toBeUndefined();
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(debugSpy).not.toHaveBeenCalled();
			expect(logSpy).not.toHaveBeenCalled();

			// The notice names BOTH probed locations: a compiled binary never has the
			// module-relative asset, so the sidecar path is the actionable one.
			const notice = String(errorSpy.mock.calls[0]?.[0] ?? "");
			expect(notice).toContain(join(tempDir, "embedded", "skill", "bun-1-4", "SKILL.md"));
			expect(notice).toContain(
				join(
					tempDir,
					"bin",
					"node_modules",
					"@code-yeongyu",
					"senpi-codemode",
					"src",
					"skill",
					"bun-1-4",
					"SKILL.md",
				),
			);
		} finally {
			debugSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});

describe("createBunSkillDiscoverHandler", () => {
	it("contributes the bundled skill when the eval kernel runs bun 1.4.2", async () => {
		const handler = createBunSkillDiscoverHandler(() => "1.4.2");
		await expect(Promise.resolve(handler())).resolves.toEqual({ skillPaths: [bunSkillMd] });
	});

	it("contributes nothing when the eval kernel runs bun 1.3.0", async () => {
		const handler = createBunSkillDiscoverHandler(() => "1.3.0");
		await expect(Promise.resolve(handler())).resolves.toBeUndefined();
	});

	it("contributes nothing on a node kernel, regardless of any bun binary on PATH", async () => {
		const handler = createBunSkillDiscoverHandler(() => undefined);
		await expect(Promise.resolve(handler())).resolves.toBeUndefined();
	});

	it("contributes nothing when the kernel version is unparseable", async () => {
		const handler = createBunSkillDiscoverHandler(() => "not-a-version");
		await expect(Promise.resolve(handler())).resolves.toBeUndefined();
	});
});

describe("registerBunSkillContribution", () => {
	it("registers one resources_discover handler that contributes on a bun >= 1.4 kernel", async () => {
		const registrations: Array<{
			event: "resources_discover";
			handler: (
				event: unknown,
				ctx: unknown,
			) => Promise<{ skillPaths?: string[] } | undefined> | { skillPaths?: string[] } | undefined;
		}> = [];
		const pi = {
			on(
				event: "resources_discover",
				handler: (
					event: unknown,
					ctx: unknown,
				) => Promise<{ skillPaths?: string[] } | undefined> | { skillPaths?: string[] } | undefined,
			): void {
				registrations.push({ event, handler });
			},
		};

		registerBunSkillContribution(pi, () => "1.4.5");

		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.event).toBe("resources_discover");
		await expect(Promise.resolve(registrations[0]?.handler({}, {}))).resolves.toEqual({ skillPaths: [bunSkillMd] });
	});
});

describe("bun-1-4 skill assets", () => {
	it("pins SKILL.md frontmatter name and exactly 10 reference markdown files", () => {
		expect(readFileSync(bunSkillMd, "utf8")).toContain("name: bun-1-4");
		const references = readdirSync(bunSkillRefs).filter((name) => name.endsWith(".md"));
		expect(references).toHaveLength(10);
	});

	it("ships English-only copy: no Hangul in SKILL.md or any reference", () => {
		const hangul = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
		const files = [bunSkillMd, ...readdirSync(bunSkillRefs).map((name) => join(bunSkillRefs, name))];
		for (const file of files) {
			expect(hangul.test(readFileSync(file, "utf8")), file).toBe(false);
		}
	});

	it("ships a single document: one frontmatter block and one H1", () => {
		const text = readFileSync(bunSkillMd, "utf8");
		expect(text.match(/^---$/gm)).toHaveLength(2);
		expect(text.match(/^# Bun 1\.4/gm)).toHaveLength(1);
		expect(text.match(/^## Operating rules$/gm)).toHaveLength(1);
	});
});
