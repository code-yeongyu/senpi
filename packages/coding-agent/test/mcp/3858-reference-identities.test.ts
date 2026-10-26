import { createHmac } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpCredentialIdentity } from "../../src/core/extensions/builtin/mcp/auth/catalog-identity.ts";
import { hashConfig, normalizeServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import { referenceRoot } from "../suite/regressions/3858-reference-support.ts";

describe("keyed configuration identities (#3858)", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		files = referenceRoot();
	});
	afterEach(() => {
		files.close();
		vi.restoreAllMocks();
	});

	it("publishes a complete private installation key and reuses it", () => {
		const config = normalizeServer({ command: "fixture", args: ["synthetic-secret"] });
		const first = Reflect.apply(hashConfig, undefined, [config, files.root]);
		const path = join(files.root, "config-identity.key");
		expect(readFileSync(path)).toHaveLength(32);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(Reflect.apply(hashConfig, undefined, [config, files.root])).toBe(first);
		expect(Reflect.apply(hashConfig, undefined, [{ ...config, args: ["rotated"] }, files.root])).not.toBe(first);
	});

	it("uses HMAC rather than an offline-guessable bearer fingerprint", () => {
		const config = normalizeServer({ type: "http", url: "https://example.invalid", bearerTokenEnv: "TOKEN" });
		const identity = mcpCredentialIdentity(config, "fixture", files.root, { TOKEN: "1234" });
		const key = readFileSync(join(files.root, "config-identity.key"));
		const expected = createHmac("sha256", key)
			.update(JSON.stringify(["mcp-catalog-bearer", "1234"]))
			.digest("hex");
		expect(identity).toBe(expected);
	});

	it.each(
		process.platform === "win32"
			? ["partial", "oversize"]
			: ["partial", "permissions", "readonly", "owner", "oversize"],
	)("warns once without replacing or trusting an invalid %s key", (kind) => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const path = files.file(
			"config-identity.key",
			kind === "partial" ? "short" : "k".repeat(kind === "oversize" ? 33 : 32),
		);
		if (kind === "permissions") chmodSync(path, 0o644);
		if (kind === "readonly") chmodSync(path, 0o400);
		if (kind === "owner" && process.getuid !== undefined) {
			vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
		}
		const before = readFileSync(path);
		const config = normalizeServer({ command: "fixture" });
		const identity = Reflect.apply(hashConfig, undefined, [config, files.root]);
		expect(identity).toMatch(/^ephemeral:/);
		expect(Reflect.apply(hashConfig, undefined, [config, files.root])).toBe(identity);
		expect(warning).toHaveBeenCalledTimes(1);
		const diagnostic = String(warning.mock.calls[0]?.[0]);
		expect(diagnostic).toContain(path);
		expect(diagnostic).toMatch(/size|mode|owner/);
		expect(diagnostic).toMatch(/repair|restore|chmod|chown/i);
		expect(diagnostic).toContain("catalog cache");
		expect(diagnostic).not.toContain(before.toString());
		expect(readFileSync(path)).toEqual(before);
	});

	it("keeps a completed published key when an abandoned temporary file exists", () => {
		files.file("config-identity.key.abandoned.tmp", "");
		const key = Buffer.alloc(32, 7);
		writeFileSync(join(files.root, "config-identity.key"), key, { mode: 0o600 });
		const config = normalizeServer({ command: "fixture" });
		expect(Reflect.apply(hashConfig, undefined, [config, files.root])).not.toMatch(/^ephemeral:/);
		expect(readFileSync(join(files.root, "config-identity.key"))).toEqual(key);
	});
});
