#!/usr/bin/env node
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRootSenpiWrapper, shouldWriteGlobalShim } from "./create-root-senpi-wrapper.mjs";

describe("create-root-senpi-wrapper", () => {
	it("does not write a global shim when the root is a gitless snapshot", () => {
		// Given
		const root = mkdtempSync(join(tmpdir(), "senpi-wrapper-snapshot-"));
		const globalPrefix = mkdtempSync(join(tmpdir(), "senpi-wrapper-global-"));

		// When
		const result = createRootSenpiWrapper({ root, globalPrefix });
		const wrapper = readFileSync(result.wrapperPath, "utf8");

		// Then
		assert.equal(shouldWriteGlobalShim(root), false);
		assert.equal(result.globalShimWritten, false);
		assert.equal(wrapper.includes("packages/coding-agent/dist/senpi"), true);
		assert.equal(wrapper.includes("scripts/build-all.mjs"), true);
		assert.equal(wrapper.includes("packages/ai/src"), true);
		assert.equal(wrapper.includes(".senpi-build-head"), true);
	});

	it("replaces an existing global symlink instead of following it", () => {
		// Given
		const root = mkdtempSync(join(tmpdir(), "senpi-wrapper-root-"));
		const globalPrefix = mkdtempSync(join(tmpdir(), "senpi-wrapper-global-"));
		const globalBin = join(globalPrefix, "bin");
		const linkedTarget = join(root, "linked-cli.js");
		mkdirSync(join(root, ".git"));
		mkdirSync(globalBin);
		writeFileSync(linkedTarget, "original", "utf8");
		symlinkSync(linkedTarget, join(globalBin, "senpi"));

		// When
		const result = createRootSenpiWrapper({ root, globalPrefix, writeGlobalShim: true });

		// Then
		assert.equal(readFileSync(linkedTarget, "utf8"), "original");
		assert.equal(lstatSync(result.globalShimPath).isSymbolicLink(), false);
		assert.equal(readFileSync(result.globalShimPath, "utf8").includes(result.wrapperPath), true);
	});
});
