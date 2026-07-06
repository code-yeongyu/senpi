#!/usr/bin/env node
// Runs `go build`/`go vet`/`go test` for packages/neo, but skips gracefully
// (exit 0) when the Go toolchain is absent, so `npm run check` stays green on
// Go-less machines. CI installs Go and gets the full gate.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const neoDir = join(repoRoot, "packages", "neo");

/** True when a `go` executable is resolvable on PATH. */
function hasGo() {
	const probe = spawnSync("go", ["version"], { stdio: "ignore" });
	// error is set (ENOENT) when the binary is missing; a non-zero status from a
	// present binary is treated as "unusable" and also skipped.
	return !probe.error && probe.status === 0;
}

if (!hasGo()) {
	console.log("check:neo skip: Go toolchain not found; skipping packages/neo checks");
	process.exit(0);
}

/** Run one `go` subcommand in packages/neo, inheriting stdio. */
function runGo(args) {
	console.log(`check:neo: go ${args.join(" ")}`);
	const result = spawnSync("go", args, { cwd: neoDir, stdio: "inherit" });
	if (result.error) {
		console.error(`check:neo: failed to spawn go: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

runGo(["build", "./..."]);
runGo(["vet", "./..."]);
runGo(["test", "./..."]);
console.log("check:neo: packages/neo build+vet+test passed");
