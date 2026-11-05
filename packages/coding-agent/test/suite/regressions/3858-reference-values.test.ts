import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateValue } from "../../../src/core/extensions/builtin/mcp/config.ts";
import { resolveConfigValue } from "../../../src/core/resolve-config-value.ts";
import { ROTATED, referenceRoot, resolveReference, SECRET } from "./3858-reference-support.ts";

// #3858: references are a typed boundary, not another string interpolation pass.
describe("reference value contract", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		files = referenceRoot();
	});
	afterEach(() => {
		files.close();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each(["cached", "uncached", "throwing"] as const)("resolves file references through %s", async (entry) => {
		const path = files.file("credential", `  ${SECRET}\n`);
		expect(await resolveReference({ $file: path }, { root: files.root, entry })).toBe(SECRET);
	});

	it("reads fresh file bytes on every use", async () => {
		const path = files.file("credential");
		await resolveReference({ $file: path }, { root: files.root });
		writeFileSync(path, ROTATED);
		expect(await resolveReference({ $file: path }, { root: files.root })).toBe(ROTATED);
	});

	it("resolves relative paths against the declaring config", async () => {
		files.file("relative");
		expect(await resolveReference({ $file: "./relative" }, { root: files.root })).toBe(SECRET);
	});

	it("resolves ~/ paths against the home directory instead of the declaring config", async () => {
		const home = referenceRoot();
		try {
			home.file("home-credential", ROTATED);
			vi.stubEnv("HOME", home.root);
			vi.stubEnv("USERPROFILE", home.root);
			expect(await resolveReference({ $file: "~/home-credential" }, { root: files.root })).toBe(ROTATED);
		} finally {
			home.close();
		}
	});

	it("keeps concat literals and resolved bytes opaque", async () => {
		const token = "$" + "{NAME}";
		const path = files.file(token, `!printf forbidden ${token} {file:never}`);
		const value = { $concat: [`${token} `, { $file: path }, { $env: "OPAQUE" }] };
		expect(
			await resolveReference(value, { root: files.root, env: { NAME: "expanded", OPAQUE: '{"$file":"never"}' } }),
		).toBe(`${token} !printf forbidden ${token} {file:never}{"$file":"never"}`);
	});

	it("treats the entire reference subtree as opaque to legacy MCP interpolation", () => {
		const token = "$" + "{NAME}";
		const value = { $concat: [token, { $file: `/secure/${token}` }] };
		expect(interpolateValue({ args: [value] }, "mcp", { NAME: "expanded" })).toEqual({ args: [value] });
	});

	it.each([{}, { $file: "" }, { $env: "MY-TOKEN" }, { $env: "A", $file: "b" }, { $concat: [{ $concat: [] }] }])(
		"rejects malformed reference %j with named fields",
		async (value) => {
			await expect(resolveReference(value, { root: files.root })).rejects.toMatchObject({
				name: "ConfigReferenceError",
				field: "provider.apiKey",
				reason: "malformed",
			});
		},
	);

	it.each(["cached", "uncached", "throwing"] as const)("propagates unset env through %s", async (entry) => {
		await expect(resolveReference({ $env: "MISSING_3858" }, { root: files.root, entry })).rejects.toMatchObject({
			name: "ConfigReferenceError",
			reason: "unset",
		});
	});

	it("fails the whole concat when an env part is empty", async () => {
		await expect(
			resolveReference({ $concat: ["Bearer ", { $env: "EMPTY" }] }, { root: files.root, env: { EMPTY: "" } }),
		).rejects.toMatchObject({ name: "ConfigReferenceError", reason: "empty" });
	});

	it.each(["untrusted", "extension", "remote-skill", "unknown"])(
		"refuses %s authority before accessing a missing file",
		async (authority) => {
			await expect(
				resolveReference({ $file: "/nonexistent-3858" }, { root: files.root, authority }),
			).rejects.toMatchObject({ name: "ConfigReferenceError", reason: "forbidden" });
		},
	);

	it("never falls back to ambient env for a reference with an explicit environment", async () => {
		vi.stubEnv("AMBIENT_3858", SECRET);
		await expect(resolveReference({ $env: "AMBIENT_3858" }, { root: files.root })).rejects.toMatchObject({
			reason: "unset",
		});
	});

	it("warns once by variable name without printing opaque env values", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = { OPAQUE_3858: `{file:${SECRET}}` };
		expect(await resolveReference({ $env: "OPAQUE_3858" }, { root: files.root, env })).toBe(env.OPAQUE_3858);
		await resolveReference({ $env: "OPAQUE_3858" }, { root: files.root, env });
		expect(warning).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warning.mock.calls)).toContain("OPAQUE_3858");
		expect(JSON.stringify(warning.mock.calls)).not.toContain(SECRET);
	});

	it("warns for legacy opaque env values without reinterpreting them", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const value = `{env:${SECRET}}`;
		const token = "$" + "{LEGACY_OPAQUE_3858}";
		expect(await resolveConfigValue(token, { LEGACY_OPAQUE_3858: value })).toBe(value);
		await resolveConfigValue(token, { LEGACY_OPAQUE_3858: value });
		expect(warning).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warning.mock.calls)).not.toContain(SECRET);
	});

	it.each(["{file:literal}", "{{env:literal}", "$" + "{file:literal}", "plain"])(
		"preserves existing literal bytes %s",
		async (value) => {
			expect(await resolveConfigValue(value)).toBe(value);
		},
	);

	it("preserves legacy interpolation inside a JSON-looking string", async () => {
		expect(await resolveConfigValue('{"$file":"literal"}', { file: "legacy-name" })).toBe(
			'{"legacy-name":"literal"}',
		);
	});

	it("preserves distinct core and MCP missing-variable behavior", async () => {
		vi.stubEnv("ABSENT_LEGACY_3858", undefined);
		const token = "$" + "{ABSENT_LEGACY_3858}";
		expect(await resolveConfigValue(token)).toBeUndefined();
		expect(interpolateValue(token, "mcp", {})).toBe("");
		expect(interpolateValue("$" + "{EMPTY:-fallback}/$" + "{ABSENT:-}", "mcp", { EMPTY: "" })).toBe("/");
	});

	it("preserves shell command resolution for legacy values", async () => {
		expect(await resolveConfigValue("!printf '  legacy-command-3858  '")).toBe("legacy-command-3858");
	});
});
