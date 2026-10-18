import type { Mode, OpenMode, PathLike } from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSkillMarkdownSource, SKILL_FRONTMATTER_PREFIX_BYTES } from "../../../src/core/skill-discovery.ts";

/**
 * A Bun single-file executable serves embedded assets from a virtual filesystem that answers
 * existsSync, statSync and readFileSync but hands out no descriptors. Paths carrying this marker
 * emulate that: openSync reports ENOENT while the bytes stay readable.
 */
const descriptorless = vi.hoisted(() => ({ marker: "descriptorless-asset", opened: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync: (path: PathLike, flags: OpenMode, mode?: Mode | null): number => {
			const target = String(path);
			if (target.includes(descriptorless.marker)) {
				throw Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), {
					code: "ENOENT",
					syscall: "open",
					path: target,
				});
			}
			descriptorless.opened.push(target);
			return actual.openSync(path, flags, mode);
		},
	};
});

function makeTempDir(label: string): string {
	const dir = join(tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("senpi#1852 skills embedded in a compiled binary", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir !== undefined) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("reads a skill whose bytes are readable even when no descriptor is available", () => {
		tempDir = makeTempDir("skill-embedded");
		const filePath = join(tempDir, `${descriptorless.marker}-SKILL.md`);
		writeFileSync(filePath, "---\nname: gpt-image-gen\ndescription: bundled skill\n---\nbody\n");

		expect(readSkillMarkdownSource(filePath)).toContain("name: gpt-image-gen");
	});

	it("still reports a file that is genuinely missing", () => {
		tempDir = makeTempDir("skill-embedded-missing");
		const missing = join(tempDir, `${descriptorless.marker}-SKILL.md`);

		expect(() => readSkillMarkdownSource(missing)).toThrow(/ENOENT/);
	});

	it("keeps reading regular files through a descriptor, bounded to the frontmatter prefix", () => {
		tempDir = makeTempDir("skill-regular");
		const filePath = join(tempDir, "SKILL.md");
		const body = "body ".repeat(SKILL_FRONTMATTER_PREFIX_BYTES);
		writeFileSync(filePath, `---\nname: regular\ndescription: regular skill\n---\n${body}\n`);
		descriptorless.opened.length = 0;

		const source = readSkillMarkdownSource(filePath);

		expect(descriptorless.opened).toContain(filePath);
		expect(source).toContain("name: regular");
		expect(source).not.toContain("body body");
	});
});
