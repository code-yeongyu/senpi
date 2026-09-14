#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export function stageImageGenSkill(repoRoot) {
	const sourcePath = join(
		repoRoot,
		"packages/coding-agent/src/core/extensions/builtin/imagegen/skill/SKILL.md",
	);
	if (!existsSync(sourcePath)) {
		return false;
	}
	const destinationPath = join(
		repoRoot,
		"packages/coding-agent/dist/core/extensions/builtin/imagegen/skill/SKILL.md",
	);
	mkdirSync(dirname(destinationPath), { recursive: true });
	copyFileSync(sourcePath, destinationPath);
	return true;
}

function main() {
	const repoRoot = resolve(process.env.PI_BUN_COMPILE_REPO_ROOT ?? join(scriptDirectory, ".."));
	const prepared = stageImageGenSkill(repoRoot);
	console.log(`[prepare-bun-compile-assets] imagegen skill ${prepared ? "prepared" : "not installed; skipping"}`);
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
