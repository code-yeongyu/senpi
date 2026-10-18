#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export function stageImageGenSkill(repoRoot) {
	const sourcePath = join(
		repoRoot,
		"packages/coding-agent/src/core/extensions/builtin/imagegen/skill/SKILL.md",
	);
	if (!existsSync(sourcePath)) return false;
	const destinationPath = join(
		repoRoot,
		"packages/coding-agent/dist/core/extensions/builtin/imagegen/skill/SKILL.md",
	);
	mkdirSync(dirname(destinationPath), { recursive: true });
	copyFileSync(sourcePath, destinationPath);
	return true;
}

export const TREE_SITTER_ASSET_DIRECTORY = "packages/agent/assets/tree-sitter";

/**
 * The compiled binary embeds these through `import ... with { type: "file" }`, so a missing or
 * drifted artifact must fail asset preparation rather than ship a binary that silently falls back.
 */
export function verifyTreeSitterGrammarAssets(repoRoot) {
	const directory = join(repoRoot, TREE_SITTER_ASSET_DIRECTORY);
	const manifestPath = join(directory, "provenance.json");
	if (!existsSync(manifestPath)) {
		throw Object.assign(new Error("Tree-sitter asset provenance is missing"), {
			code: "READ_SUMMARY_GRAMMAR_ASSET_MISSING",
			path: manifestPath,
		});
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const artifacts = [manifest.runtime, ...manifest.grammars];
	for (const artifact of artifacts) {
		const path = join(directory, artifact.file);
		if (!existsSync(path)) {
			throw Object.assign(new Error(`Tree-sitter asset is missing: ${artifact.file}`), {
				code: "READ_SUMMARY_GRAMMAR_ASSET_MISSING",
				path,
			});
		}
		const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
		if (sha256 !== artifact.sha256) {
			throw Object.assign(new Error(`Tree-sitter asset drifted: ${artifact.file}`), {
				code: "READ_SUMMARY_GRAMMAR_ASSET_DRIFT",
				path,
				expected: artifact.sha256,
				actual: sha256,
			});
		}
	}
	return artifacts.map((artifact) => ({ file: artifact.file, sha256: artifact.sha256 }));
}

export function measureReadSummaryBinaryDelta({ baselineBytes, candidateBytes, maxDeltaBytes }) {
	for (const value of [baselineBytes, candidateBytes, maxDeltaBytes]) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw Object.assign(new Error("Invalid read-summary binary byte measurement"), {
				code: "READ_SUMMARY_BINARY_MEASUREMENT_INVALID",
			});
		}
	}
	const deltaBytes = candidateBytes - baselineBytes;
	const measurement = { baselineBytes, candidateBytes, deltaBytes, maxDeltaBytes };
	if (deltaBytes > maxDeltaBytes) {
		throw Object.assign(new Error("Read-summary binary delta exceeds the selected asset budget"), {
			code: "READ_SUMMARY_BINARY_BUDGET_EXCEEDED",
			...measurement,
		});
	}
	return measurement;
}

function main() {
	const repoRoot = resolve(process.env.PI_BUN_COMPILE_REPO_ROOT ?? join(scriptDirectory, ".."));
	const prepared = stageImageGenSkill(repoRoot);
	console.log(`[prepare-bun-compile-assets] imagegen skill ${prepared ? "prepared" : "not installed; skipping"}`);
	// The package that ships the grammars is the authority: where it exists, its assets must too.
	if (!existsSync(join(repoRoot, "packages/agent/package.json"))) {
		console.log("[prepare-bun-compile-assets] agent package not installed; skipping tree-sitter assets");
		return;
	}
	const grammars = verifyTreeSitterGrammarAssets(repoRoot);
	console.log(`[prepare-bun-compile-assets] tree-sitter assets verified: ${grammars.map((g) => g.file).join(", ")}`);
}

// macOS TMPDIR may be a symlink, so compare real entry paths.
function realPathOrSelf(path) {
	try {
		return realpathSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return path;
		throw error;
	}
}

if (process.argv[1] && realPathOrSelf(fileURLToPath(import.meta.url)) === realPathOrSelf(resolve(process.argv[1]))) {
	main();
}
