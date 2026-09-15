#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const nativeJob = workflow.match(/^  grep-native-contract:\n[\s\S]*?(?=^  [\w-]+:|$(?![\s\S]))/m)?.[0];
const fanIn = workflow.match(/^  check-and-test:\n[\s\S]*?(?=^  [\w-]+:|$(?![\s\S]))/m)?.[0];

describe("grep native contract CI", () => {
	it("builds the locked native crate on Linux with the repository toolchain and Rust cache", () => {
		assert.ok(nativeJob, "missing grep-native-contract job");
		assert.match(nativeJob, /runs-on: ubuntu-latest/);
		assert.match(nativeJob, /npm ci --ignore-scripts/);
		assert.match(nativeJob, /npm run build/);
		assert.match(nativeJob, /oven-sh\/setup-bun@[a-f0-9]{40}/);
		assert.match(nativeJob, /rust-toolchain\.toml/);
		assert.match(nativeJob, /rustup toolchain install "\$toolchain" --profile minimal/);
		assert.match(nativeJob, /Swatinem\/rust-cache@[a-f0-9]{40}/);
		assert.match(nativeJob, /cargo build -p senpi-grep --release --locked/);
		assert.match(nativeJob, /napi build --platform --release -- --locked\n\s+working-directory: crates\/senpi-grep/);
	});

	it("resolves the generated addon before running both engines in the same package", () => {
		assert.ok(nativeJob, "missing grep-native-contract job");
		assert.match(nativeJob, /node_file=\$\(ls crates\/senpi-grep\/senpi_grep\.\*\.node\)/);
		assert.match(nativeJob, /export SENPI_GREP_NATIVE_PATH="\$PWD\/\$node_file"\n\s+cd packages\/coding-agent/);
		assert.match(nativeJob, /SENPI_GREP_ENGINE=native bunx vitest run test\/grep --reporter=default --reporter=json/);
		assert.match(nativeJob, /contract\.assertionResults\.every\(\(test\) => test\.status === "passed"\)/);
		assert.match(nativeJob, /SENPI_GREP_ENGINE=rg bunx vitest run test\/grep/);
		assert.doesNotMatch(nativeJob, /senpi_grep\.linux-x64-gnu\.node/);
	});

	it("requires the contract job in the existing fan-in gate without adding Windows grep coverage", () => {
		assert.ok(fanIn, "missing check-and-test job");
		assert.match(fanIn, /needs:\s*\[[^\]]*\bgrep-native-contract\b/);
		for (const job of workflow.matchAll(/^  [\w-]+:\n[\s\S]*?(?=^  [\w-]+:|$(?![\s\S]))/gm)) {
			if (job[0].includes("windows-latest")) assert.doesNotMatch(job[0], /vitest run test\/grep/);
		}
	});
});
