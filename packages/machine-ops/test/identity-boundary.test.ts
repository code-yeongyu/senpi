import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, IdentityOutputStream } from "../src/index.ts";
import { createLocalMachineOps } from "../src/local.ts";
import { createInProcessHolderLink } from "../src/process/in-process-holder.ts";
import type { OpContext } from "../src/types.ts";

const ctx: OpContext = {
	scope: { id: "fixture" },
	principal: { kind: "local-session", id: "test" },
	signal: new AbortController().signal,
	limits: DEFAULT_LIMITS,
	policy: {},
};
const fake = "X".repeat(43);
let home: string;
let identity: string;
const ops = createLocalMachineOps({ holder: createInProcessHolderLink() });

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "identity-boundary-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
	vi.stubEnv("OMO_DEVICE_SERVICE_STATE_DIR", join(home, "state"));
	mkdirSync(join(home, ".omo/sub"), { recursive: true });
	identity = join(home, ".omo/device-identity.json");
	writeFileSync(identity, JSON.stringify({ signing: fake, label: "fixture" }));
	symlinkSync(identity, join(home, "link"));
	linkSync(identity, join(home, "hard"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("file effects refuse the identity before exposing bytes or metadata", () => {
	it.each([".omo/device-identity.json", "link", "hard", ".omo/sub/../device-identity.json"])("%s", async (alias) => {
		const path = `${home}/${alias}`;
		for (const effect of [
			() => ops.files.read({ path }, ctx),
			() => ops.files.read({ path, offset: 1, limitBytes: 3 }, ctx),
			() => ops.files.stat({ path }, ctx),
			() => ops.files.list({ path }, ctx),
			() => ops.files.glob({ cwd: path, pattern: "*" }, ctx),
			() => ops.files.grep({ path, pattern: "fixture" }, ctx),
			() => ops.files.edit({ path, exact: "fixture", replacement: "changed" }, ctx),
			() => ops.files.write({ path, bytes: new Uint8Array() }, ctx),
		]) {
			// Assert on the error only: a regression cannot dump fixture bytes into the test log.
			const reason = await effect().then(
				() => undefined,
				(error: Error) => error.message,
			);
			expect(reason).toBe(`IDENTITY_FILE_REFUSED ${identity}`);
		}
	});

	it("uses the existing real parent for a missing vault target", async () => {
		const config = join(home, "config");
		mkdirSync(config);
		symlinkSync(config, join(home, "alias-config"), "dir");
		await expect(
			ops.files.write(
				{
					path: join(home, "alias-config/typevault/identity.json"),
					bytes: new Uint8Array(),
					createParentDirs: true,
				},
				ctx,
			),
		).rejects.toThrow("IDENTITY_FILE_REFUSED");
	});
	it.each([
		"device-identity.pending",
		"device-identity.json.bak",
		"device-identity.json.123.tmp",
		"device-identity.json.rotated.1",
	])("refuses %s and its unrelated hard link", async (name) => {
		const original = join(home, ".omo", name),
			alias = join(home, "archived");
		writeFileSync(original, "{}");
		linkSync(original, alias);
		for (const path of [original, alias])
			await expect(ops.files.stat({ path }, ctx)).rejects.toThrow("IDENTITY_FILE_REFUSED");
	});
});

describe("ordinary file operations keep their filesystem semantics", () => {
	it("preserves unrelated names, contents and distinct case variants", async () => {
		const path = join(home, "device-identity.json");
		writeFileSync(path, "ordinary");
		expect(Buffer.from((await ops.files.read({ path }, ctx)).bytes).toString()).toBe("ordinary");
		expect((await ops.files.stat({ path }, ctx)).size).toBe(8);
		expect((await ops.files.grep({ path, pattern: "ordinary" }, ctx)).matches.length).toBe(1);
		const variant = join(home, ".omo/DEVICE-IDENTITY.JSON");
		if (statSync(variant, { throwIfNoEntry: false })) {
			await expect(ops.files.stat({ path: variant }, ctx)).rejects.toThrow("IDENTITY_FILE_REFUSED");
		} else {
			writeFileSync(variant, "different");
			expect((await ops.files.stat({ path: variant }, ctx)).size).toBe(9);
		}
	});
});

describe("shell output is redacted before capture and callbacks", () => {
	it.each([
		"cat .omo/device-identity.json",
		"cp .omo/device-identity.json copy && cat copy",
		`python3 -c "import json; print(json.load(open('.omo/device-identity.json')))"`,
	])("%s", async (command) => {
		let streamed = "";
		const result = await ops.process.exec(
			{
				command,
				cwd: home,
				onOutput: (chunk) => {
					streamed += Buffer.from(chunk).toString();
				},
			},
			ctx,
		);
		expect(result.exitCode).toBe(0);
		for (const output of [streamed, Buffer.from(result.stdout).toString()]) {
			expect(output.includes(fake)).toBe(false);
			expect(output.includes("[REDACTED]") && output.includes("fixture")).toBe(true);
		}
	});
	it("does not release an identity value at any chunk split, and preserves generic keys", () => {
		const text = JSON.stringify({ signing: fake, key: fake, sk: fake, Key: "photos/file.jpg" });
		for (let cut = 0; cut <= text.length; cut++) {
			const redactor = new IdentityOutputStream();
			const first = redactor.push(text.slice(0, cut));
			const clean = first + redactor.push(text.slice(cut)) + redactor.finish();
			expect(clean === JSON.stringify({ signing: "[REDACTED]", key: fake, sk: fake, Key: "photos/file.jpg" })).toBe(
				true,
			);
		}
	});
});
