import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildFingerprint } from "../../scripts/gate-build-inputs.ts";
import { runProcess } from "../../scripts/gate-process.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it("rejects source changed during a successful build before certifying its old output", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-build-race-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const value = 1;");
		await writeFile(join(root, "package.json"), '{"scripts":{"build":"bun build-fixture.ts"}}');
		await writeFile(
			join(root, "build-fixture.ts"),
			`
await Bun.write("packages/ai/dist/index.js", await Bun.file("packages/ai/src/index.ts").text());
await Bun.write("packages/ai/src/index.ts", "export const value = 2;");
`,
		);
		const result = await runProcess(["bun", "scripts/gate-build.ts", root], packageRoot);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("changed during build");
		expect(await readFile(join(workspace, "dist/index.js"), "utf8")).toContain("value = 1");
		await expect(stat(join(workspace, ".senpi-gate-inputs.json"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 180_000);

it("fingerprints compiler-valid JSONC inherited configurations", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-jsonc-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const value = 1;");
		await writeFile(
			join(workspace, "tsconfig.build.json"),
			'{ // compiler accepts comments\n"extends": "../../base.json",\n}',
		);
		await writeFile(join(root, "base.json"), '{ /* inherited options */ "compilerOptions": {"strict": true,}, }');
		const before = await buildFingerprint(workspace);
		expect(before).toHaveProperty("../../base.json");
		await writeFile(join(root, "base.json"), '{ /* changed options */ "compilerOptions": {"strict": false,}, }');
		const after = await buildFingerprint(workspace);
		expect(after["../../base.json"]).not.toBe(before["../../base.json"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
