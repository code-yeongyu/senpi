#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const codingAgentNodeModules = join(root, "packages/coding-agent/node_modules/@earendil-works");

const bundledWorkspaces = [
	{ source: "packages/agent", targetName: "pi-agent-core" },
	{ source: "packages/ai", targetName: "pi-ai" },
	{ source: "packages/tui", targetName: "pi-tui" },
];

function shouldCopyWorkspaceFile(sourceRoot, sourcePath) {
	const path = relative(sourceRoot, sourcePath);
	return (
		path === "" ||
		path === "package.json" ||
		path === "README.md" ||
		path === "CHANGELOG.md" ||
		path === "dist" ||
		path.startsWith(`dist/`)
	);
}

for (const workspace of bundledWorkspaces) {
	const sourceRoot = join(root, workspace.source);
	const distPath = join(sourceRoot, "dist");
	if (!existsSync(distPath)) {
		throw new Error(`Missing ${distPath}. Run npm run build before preparing bundled workspaces.`);
	}

	const targetRoot = join(codingAgentNodeModules, workspace.targetName);
	rmSync(targetRoot, { recursive: true, force: true });
	mkdirSync(dirname(targetRoot), { recursive: true });
	cpSync(sourceRoot, targetRoot, {
		recursive: true,
		filter: (sourcePath) => shouldCopyWorkspaceFile(sourceRoot, sourcePath),
	});
}
