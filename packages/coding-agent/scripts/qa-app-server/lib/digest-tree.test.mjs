import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { digestTree } from "./digest-tree.mjs";

function expectedDigest(entries) {
	const hash = createHash("sha256");
	for (const [relative, type, content] of entries) {
		hash.update(`${Buffer.byteLength(relative)}:${relative}${type.length}:${type}`);
		if (content !== undefined) {
			const value = Buffer.isBuffer(content) ? content : Buffer.from(content);
			hash.update(`${value.length}:`);
			hash.update(value);
		}
	}
	return hash.digest("hex");
}

test("digestTree preserves explicit missing-directory handling", () => {
	assert.equal(digestTree(join(tmpdir(), `senpi-digest-missing-${process.pid}`)), createHash("sha256").update("missing").digest("hex"));
});

test("digestTree hashes files, directories, and links without following links", () => {
	const temp = mkdtempSync(join(tmpdir(), "senpi-digest-tree-"));
	onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
	const root = join(temp, "tree");
	const outside = join(temp, "outside");
	mkdirSync(join(root, "nested"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(root, "file.txt"), Buffer.from([0x00, 0x61, 0xff]));
	writeFileSync(join(root, "nested", "child.txt"), "child");
	writeFileSync(join(outside, "outside.txt"), "outside-before");
	symlinkSync("../outside", join(root, "valid-link"));
	symlinkSync("missing-target", join(root, "broken-link"));

	const expected = expectedDigest([
		["broken-link", "symlink", "missing-target"],
		["file.txt", "file", Buffer.from([0x00, 0x61, 0xff])],
		["nested", "directory"],
		["nested/child.txt", "file", "child"],
		["valid-link", "symlink", "../outside"],
	]);
	assert.equal(digestTree(root), expected);

	writeFileSync(join(outside, "outside.txt"), "outside-after");
	assert.equal(digestTree(root), expected);
});
