#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import husky from "husky";

try {
	const problem = husky();
	if (problem) throw new Error(problem.trim());
	const path = execFileSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim();
	if (path !== ".husky/_") throw new Error(`Git is using "${path}" instead of .husky/_`);
	accessSync(".husky/_/pre-push", constants.X_OK);
	console.log("Git hooks installed (including pre-push)");
} catch (error) {
	console.error(`setup:hooks: ${error.message}`);
	process.exitCode = 1;
}
