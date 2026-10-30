#!/usr/bin/env node
// Release test-evidence modes (senpi#4981): the default and --force-tests are unchanged, and a local whole-suite receipt
// is accepted only for the exact pinned release sha, never together with --force-tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { planTestEvidence } from "./release-evidence.mjs";

const SHA = "b7be6744c8d1a2f3e4b5c6d7e8f9a0b1c2d3e4f5";
const OTHER = "59b5053720b9271832f8e07b91308f25507398f3";
const base = { forceTests: false, pinnedSha: null, localReceiptSha: null, localReceipt: null };

describe("planTestEvidence (senpi#4981)", () => {
	it("keeps the default CI wait and --force-tests exactly as before", () => {
		assert.deepEqual(planTestEvidence(base), { mode: "ci" });
		assert.deepEqual(planTestEvidence({ ...base, pinnedSha: SHA }), { mode: "ci" });
		assert.deepEqual(planTestEvidence({ ...base, forceTests: true }), { mode: "force-tests" });
	});

	it("accepts a named receipt at the exact pinned sha and records it", () => {
		const plan = planTestEvidence({ ...base, pinnedSha: SHA.toUpperCase(), localReceiptSha: SHA, localReceipt: " rt-sfull-1030 " });
		assert.deepEqual(plan, { mode: "local-receipt", sha: SHA, receipt: "rt-sfull-1030" });
	});

	for (const [name, patch, refusal] of [
		["a receipt sha without a receipt", { pinnedSha: SHA, localReceiptSha: SHA }, /go together/],
		["a receipt without a sha", { pinnedSha: SHA, localReceipt: "rt" }, /go together/],
		["an empty receipt label", { pinnedSha: SHA, localReceiptSha: SHA, localReceipt: "  " }, /go together/],
		["an empty receipt sha", { pinnedSha: SHA, localReceiptSha: "", localReceipt: "rt" }, /go together/],
		["a short sha", { pinnedSha: SHA, localReceiptSha: SHA.slice(0, 10), localReceipt: "rt" }, /full 40-hex sha/],
		["an uppercase receipt sha", { pinnedSha: SHA, localReceiptSha: SHA.toUpperCase(), localReceipt: "rt" }, /full 40-hex sha/],
		["--force-tests as well", { forceTests: true, pinnedSha: SHA, localReceiptSha: SHA, localReceipt: "rt" }, /pass one of them/],
		["an unpinned release", { localReceiptSha: SHA, localReceipt: "rt" }, /needs a pinned release/],
		["a receipt for another sha", { pinnedSha: OTHER, localReceiptSha: SHA, localReceipt: "rt" }, /covers b7be6744c8d1, but the release pins 59b5053720b9/],
	]) {
		it(`refuses ${name}`, () => {
			assert.throws(() => planTestEvidence({ ...base, ...patch }), refusal);
		});
	}
});

describe("release.mjs refuses a receipt it cannot rely on before doing any work (senpi#4981)", () => {
	const release = (args) =>
		spawnSync(process.execPath, [fileURLToPath(new URL("./release.mjs", import.meta.url)), "--dry-run", ...args], { encoding: "utf8" });

	it("refuses a receipt on an unpinned release", () => {
		const result = release(["--local-receipt-sha", SHA, "--local-receipt", "rt"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /needs a pinned release/);
		assert.doesNotMatch(result.stdout, /target version/);
	});

	it("refuses a receipt for a sha other than the pinned one", () => {
		const result = release(["--sha", OTHER, "--local-receipt-sha", SHA, "--local-receipt", "rt"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /covers b7be6744c8d1, but the release pins 59b5053720b9/);
	});
});
