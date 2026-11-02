import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectResolves } from "../../src/environments/project-resolves.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function projectWith(manifest: string, files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-project-resolves-"));
	roots.push(root);
	const dir = join(root, "node_modules", "pkg");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), manifest);
	for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
	return root;
}

// The conflict check mirrors the import resolver, which throws on a null manifest (so the project copy wins and fails)
// and reads any other non-object manifest as one without fields.
describe("Given a project copy of a package with an unusual package.json", () => {
	it("When the manifest is null, then the project copy counts as resolving", async () => {
		const project = await projectWith("null", {});

		expect(projectResolves(project, "pkg")).toBe(true);
	});

	it("When the manifest is a string and the package has an index.js, then the project copy counts as resolving", async () => {
		const project = await projectWith('"just a string"', { "index.js": "export {};\n" });

		expect(projectResolves(project, "pkg")).toBe(true);
	});

	it("When the manifest is a string and the package has no index.js, then the project copy does not resolve", async () => {
		const project = await projectWith('"just a string"', {});

		expect(projectResolves(project, "pkg")).toBe(false);
	});
});
