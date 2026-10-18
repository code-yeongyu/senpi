import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { captureTargetBuild, recordTargetBuild } from "../../scripts/gate-build-inputs.ts";
import { runProcess } from "../../scripts/gate-process.ts";
import { assertFreshTarget } from "../../scripts/gate-target.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function recordFixtureBuild(target: string): Promise<void> {
	await recordTargetBuild(target, await captureTargetBuild(target));
}

it.each(["dist", "entry", "sidecar"])("does not certify build output through a %s symlink", async (linked) => {
	// Given: a target-controlled link to an external artifact or certification path.
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-linked-"));
	try {
		const workspace = join(root, "packages/ai");
		const outside = join(root, "outside");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await mkdir(outside);
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const value = 1;");
		await writeFile(join(outside, "index.js"), "export const value = 1;");
		await writeFile(join(outside, "certificate.json"), "external certificate");
		switch (linked) {
			case "dist":
				await rm(join(workspace, "dist"), { recursive: true });
				await symlink(outside, join(workspace, "dist"), "junction");
				break;
			case "entry":
				await symlink(join(outside, "index.js"), join(workspace, "dist/index.js"));
				break;
			case "sidecar":
				await writeFile(join(workspace, "dist/index.js"), "export const value = 1;");
				await symlink(join(outside, "certificate.json"), join(workspace, ".senpi-gate-inputs.json"));
				break;
			default:
				throw new TypeError("Unknown link fixture");
		}
		// When / Then: certification refuses the link and preserves external bytes.
		await expect(recordFixtureBuild(join(root, "packages/senpi-codemode"))).rejects.toThrow();
		expect(await readFile(join(outside, "certificate.json"), "utf8")).toBe("external certificate");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("refuses to measure changed source after its workspace build was certified", async () => {
	// Given: matching certified output, followed by a deterministic source change.
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-stale-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await mkdir(join(root, "packages/senpi-codemode"));
		await writeFile(join(workspace, "package.json"), '{"name":"@earendil-works/pi-ai","main":"./dist/index.js"}');
		await utimes(join(workspace, "package.json"), 100, 100);
		await writeFile(join(workspace, "src/index.ts"), "export const model = 'obsolete';");
		await writeFile(join(workspace, "dist/index.js"), "export const model = 'obsolete';");
		await recordFixtureBuild(join(root, "packages/senpi-codemode"));
		await writeFile(join(workspace, "src/index.ts"), "export const model = 'current';");
		await utimes(join(workspace, "dist/index.js"), 100, 100);
		await utimes(join(workspace, "src/index.ts"), 200, 200);
		// When: the real gate is asked to record this target as the baseline.
		const result = await runProcess(
			["bun", "scripts/gate-eval.ts", "--target", root, "--write-baseline", "--report", join(root, "report.json")],
			packageRoot,
		);
		// Then: it rejects the stale package before measurement, rather than certifying its old graph.
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("stale workspace dist: packages/ai");
		expect(result.stderr).toContain("changed or deleted inputs: src/index.ts");
		const artifact: unknown = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
		expect(artifact).toMatchObject({
			report: { unmeasured: expect.arrayContaining(["imports", "legacyContracts"]) },
			failures: expect.any(Array),
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 180_000);

it("allows workspace output rebuilt after its source changed", async () => {
	// Given: an entry built after every input in the target workspace.
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-fresh-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const model = 'current';");
		await writeFile(join(workspace, "dist/index.js"), "export const model = 'current';");
		await utimes(join(workspace, "package.json"), 100, 100);
		await utimes(join(workspace, "src/index.ts"), 200, 200);
		await utimes(join(workspace, "dist/index.js"), 300, 300);
		await recordFixtureBuild(join(root, "packages/senpi-codemode"));
		expect(await readdir(join(workspace, "dist"))).toEqual(["index.js"]);
		const certificate: unknown = JSON.parse(await readFile(join(workspace, ".senpi-gate-inputs.json"), "utf8"));
		expect(certificate).toHaveProperty("src/index.ts");
		// When: the gate checks the freshly built target.
		const measured = assertFreshTarget(join(root, "packages/senpi-codemode"));
		// Then: it permits measurement instead of rejecting a valid rebuild.
		await expect(measured).resolves.toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects a deleted source even when every remaining input predates the build", async () => {
	// Given: build evidence names a source no longer present in the checkout.
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-deleted-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const model = 1;");
		await writeFile(join(workspace, "dist/index.js"), "export const model = 1;");
		await writeFile(join(workspace, "src/deleted.ts"), "export const removed = 2;");
		await utimes(join(workspace, "package.json"), 100, 100);
		await utimes(join(workspace, "src/index.ts"), 100, 100);
		await utimes(join(workspace, "src/deleted.ts"), 100, 100);
		await utimes(join(workspace, "dist/index.js"), 200, 200);
		await recordFixtureBuild(join(root, "packages/senpi-codemode"));
		await rm(join(workspace, "src/deleted.ts"));
		// When / Then: mtime equality cannot certify a deleted module.
		await expect(assertFreshTarget(join(root, "packages/senpi-codemode"))).rejects.toThrow(
			"changed or deleted inputs: src/deleted.ts",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("requires a rebuild after an inherited config changes even with unchanged mtimes", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-config-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const value = 1;");
		await writeFile(join(workspace, "dist/index.js"), "export const value = 1;");
		await writeFile(join(workspace, "tsconfig.build.json"), '{"extends":"../../tsconfig.base.json"}');
		await writeFile(join(root, "tsconfig.base.json"), '{"compilerOptions":{"strict":true}}');
		for (const path of ["package.json", "src/index.ts", "tsconfig.build.json"])
			await utimes(join(workspace, path), 100, 100);
		await utimes(join(root, "tsconfig.base.json"), 100, 100);
		await utimes(join(workspace, "dist/index.js"), 200, 200);
		const target = join(root, "packages/senpi-codemode");
		await recordFixtureBuild(target);
		await expect(assertFreshTarget(target)).resolves.toBeUndefined();
		await writeFile(join(root, "tsconfig.base.json"), '{"compilerOptions":{"strict":false}}');
		await utimes(join(root, "tsconfig.base.json"), 100, 100);
		await expect(assertFreshTarget(target)).rejects.toThrow("tsconfig.base.json");
		await recordFixtureBuild(target);
		await expect(assertFreshTarget(target)).resolves.toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("treats a checkout with a package-like suffix as a checkout", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-checkout-"));
	try {
		const checkout = join(root, "fixture-senpi-codemode");
		const workspace = join(checkout, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await mkdir(join(checkout, "packages/senpi-codemode"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const value = 1;");
		await writeFile(join(workspace, "dist/index.js"), "export const value = 0;");
		const result = await runProcess(
			["bun", "scripts/gate-eval.ts", "--target", checkout, "--report", join(root, "report.json")],
			packageRoot,
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("stale workspace dist: packages/ai");
		expect(result.stderr).toContain("missing input fingerprint");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 180_000);

it("accepts unchanged certified content after an input timestamp refresh", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-touch-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const value = 1;");
		await writeFile(join(workspace, "dist/index.js"), "export const value = 1;");
		await utimes(join(workspace, "package.json"), 100, 100);
		await utimes(join(workspace, "src/index.ts"), 100, 100);
		await utimes(join(workspace, "dist/index.js"), 200, 200);
		const target = join(root, "packages/senpi-codemode");
		await recordFixtureBuild(target);
		await utimes(join(workspace, "src/index.ts"), 300, 300);
		await expect(assertFreshTarget(target)).resolves.toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("labels a missing built entry with its workspace instead of a raw filesystem error", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-missing-entry-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await expect(recordFixtureBuild(join(root, "packages/senpi-codemode"))).rejects.toMatchObject({
			name: "GateInputError",
			input: expect.stringContaining("packages/ai"),
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
