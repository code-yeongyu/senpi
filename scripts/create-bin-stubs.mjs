#!/usr/bin/env node
// Pre-populate the dist/*.js targets of each workspace `bin` entry.
//
// pnpm (and to a lesser extent bun) try to create bin symlinks from every
// dependent workspace's node_modules/.bin to the declared target inside each
// producer workspace (e.g. packages/agent/node_modules/.bin/pi-ai ->
// packages/ai/dist/cli.js). On a fresh clone, those dist files don't exist
// yet and pnpm prints `ENOENT ... chmod ... dist/cli.js` WARN lines for every
// dependent. Running build immediately after does create them, but by then
// the warnings are already on screen.
//
// This script runs as the root `preinstall` hook. It writes a minimal Node
// shebang stub for every missing bin target so the symlink succeeds cleanly.
// The real build step overwrites these stubs with the actual compiled CLI.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

const WORKSPACE_PACKAGES = [
	"packages/agent",
	"packages/ai",
	"packages/coding-agent",
	"packages/mom",
	"packages/pods",
	"packages/tui",
	"packages/web-ui",
];

const STUB_CONTENT = `#!/usr/bin/env node
// Build stub. Will be replaced by the real compiled CLI during build.
console.error("This workspace has not been built yet. Run 'npm run build' (or pnpm/bun equivalent) from the repo root first.");
process.exit(1);
`;

for (const rel of WORKSPACE_PACKAGES) {
	const pkgPath = join(root, rel, "package.json");
	if (!existsSync(pkgPath)) continue;
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch {
		continue;
	}
	if (!pkg.bin || typeof pkg.bin !== "object") continue;
	for (const target of Object.values(pkg.bin)) {
		if (typeof target !== "string") continue;
		const absTarget = resolve(join(root, rel), target);
		if (existsSync(absTarget)) continue;
		mkdirSync(dirname(absTarget), { recursive: true });
		writeFileSync(absTarget, STUB_CONTENT, "utf-8");
		try {
			chmodSync(absTarget, 0o755);
		} catch {
			// Windows doesn't need chmod; bin linkers handle executability.
		}
	}
}
