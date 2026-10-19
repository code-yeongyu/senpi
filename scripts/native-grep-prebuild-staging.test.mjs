import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	consumerWorkflow,
	grepBytes,
	mergeArtifacts,
	packedFiles,
	packedPathSet,
	repoRoot,
	runBash,
	stageArtifact,
	stepRunBlock,
	targets,
} from "./native-prebuild-staging.test-support.mjs";
import { assertSenpiPackedWorkspaceFiles, nativePrebuildFile } from "./senpi-publish-pack-checks.mjs";

const GREP_STAGE_STEP = "Stage grep prebuilds into the coding-agent package";
const realCodingAgentManifest = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"));
const grepPath = (host) => nativePrebuildFile(host, "@code-yeongyu/senpi");

// A coding-agent package whose `files` list is the real one (plus the `vendor` entry that
// stagePublishManifest appends at publish time), so npm decides what ships exactly as it
// does for the release tarball.
function writeCodingAgentFixture(packageDir) {
	const manifest = { name: "@code-yeongyu/senpi", version: "0.0.0", files: [...realCodingAgentManifest.files, "vendor"] };
	for (const path of [
		"dist/cli.js",
		"dist/bundle/cli.js",
		"vendor/pi-client/index.js",
		"vendor/pi-client/index.d.ts",
		"vendor/pi-protocol/index.js",
		"vendor/pi-protocol/index.d.ts",
	]) {
		mkdirSync(join(packageDir, path, ".."), { recursive: true });
		writeFileSync(join(packageDir, path), "export {};\n");
	}
	writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest));
	return manifest;
}

// Producer -> merged download -> the publish-only staging steps, as publish-npm.yml runs them.
function publishOnlyCheckout(root, consumerSteps) {
	const artifactDirs = targets.map((target) => {
		const { result, artifactDir } = stageArtifact(root, target);
		assert.equal(result.status, 0, `${target.host}: ${result.stderr}`);
		return artifactDir;
	});
	const checkout = join(root, "checkout");
	const packageDir = join(checkout, "packages/coding-agent");
	const manifest = writeCodingAgentFixture(packageDir);
	mergeArtifacts(artifactDirs, join(checkout, "packages/pty/.native-prebuild-artifacts"));
	for (const script of consumerSteps) {
		const result = runBash(script, { cwd: checkout, env: {} });
		assert.equal(result.status, 0, result.stderr);
	}
	return { packageDir, manifest };
}

describe("native grep prebuild staging into the published senpi package (senpi#3513)", () => {
	it("ships every target's grep addon where the grep loader probes, and the pack guard accepts it", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-grep-staging-"));
		try {
			// Given: the producer matrix rows and the publish-only grep staging step.
			const { packageDir, manifest } = publishOnlyCheckout(root, [stepRunBlock(consumerWorkflow, GREP_STAGE_STEP)]);

			// When: npm packs the coding-agent package with its real files list.
			const packed = packedFiles(packageDir);
			const paths = packedPathSet(packed);

			// Then: each target's grep bytes sit at <package>/native/prebuilds/<host>/senpi_grep.<host>.node.
			for (const target of targets) {
				assert.ok(paths.has(grepPath(target.host)), `${target.host}: grep prebuild missing from the tarball`);
				assert.deepEqual(readFileSync(join(packageDir, grepPath(target.host))), grepBytes(target.host));
			}
			assert.ok(![...paths].some((path) => path.includes("senpi_pty.")), "PTY addon leaked into the senpi tarball");
			const required = { requiredNativePrebuildTargets: targets.map((target) => target.host) };
			assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packed, manifest, required));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails the publish pack check when the grep staging step is skipped", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-grep-staging-skipped-"));
		try {
			// Given: the merged download exists but nothing copies the grep addons into the package.
			const { packageDir, manifest } = publishOnlyCheckout(root, []);
			assert.ok(!existsSync(join(packageDir, "native")), "fixture must start without staged prebuilds");

			// When / Then: a release that requires these targets refuses the tarball, naming the missing file.
			const packed = packedFiles(packageDir);
			assert.throws(
				() => assertSenpiPackedWorkspaceFiles(packed, manifest, { requiredNativePrebuildTargets: [targets[1].host] }),
				/native\/prebuilds\/darwin-arm64\/senpi_grep\.darwin-arm64\.node/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the check off when no targets are required, so local packs without prebuilds still work", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-grep-staging-local-"));
		try {
			const { packageDir, manifest } = publishOnlyCheckout(root, []);
			assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packedFiles(packageDir), manifest));
			assert.throws(
				() => assertSenpiPackedWorkspaceFiles(packedFiles(packageDir), manifest, { requiredNativePrebuildTargets: ["sunos-x64"] }),
				/Unsupported native prebuild target: sunos-x64/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
