import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unpinnedCargoDependencies } from "./check-cargo-pinned-deps.mjs";

describe("check-cargo-pinned-deps", () => {
	it("accepts exact pins, workspace entries, and path entries in every dependency table", () => {
		const manifest = [
			"[workspace.dependencies]",
			'png = "=0.18.1"',
			'zbus = { version = "=5.19.0", default-features = false, features = [',
			'    "async-io",',
			"] }",
			"[dependencies]",
			"serde = { workspace = true }",
			'core = { path = "../core" }',
			"[target.'cfg(target_os = \"linux\")'.dependencies]",
			'futures = "=0.3.32"',
			"[dev-dependencies]",
			"tempfile.workspace = true",
		].join("\n");
		assert.deepEqual(unpinnedCargoDependencies(manifest, "Cargo.toml"), []);
	});

	it("flags caret and bare versions, in string and table form", () => {
		const manifest = [
			"[workspace.dependencies]",
			'zbus = { version = "5.19", default-features = false }',
			'png = "0.18.1"',
			'ashpd.version = "0.11"',
			"[package]",
			'version = "1.0.0"',
		].join("\n");
		assert.deepEqual(
			unpinnedCargoDependencies(manifest, "Cargo.toml").map((problem) => problem.split(" ")[2]),
			["zbus", "png", "ashpd"],
		);
	});
});
