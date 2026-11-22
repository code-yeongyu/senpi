import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CustodySidecar,
	custodySidecarPath,
	readCustodySidecar,
	writeCustodySidecar,
} from "../../src/core/egress/custody-sidecar.ts";
import { valueImportClosure } from "./value-import-closure.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

const SIDECAR: CustodySidecar = {
	v: 1,
	providers: {
		gateway: { custody: "sealed", apiKeyTtlSeconds: 3600, secretUrlParts: ["urlPath:1", "urlQuery:project"] },
		lab: { custody: "device" },
	},
	consent: { sig: "c2ln", payload: { toggles: { lab: "device" } } },
};

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "custody-sidecar-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("custody.json reader", () => {
	it("reports a missing sidecar as absent", async () => {
		expect(await readCustodySidecar(custodySidecarPath(dir))).toEqual({ state: "absent" });
	});

	it.each([
		["not json", "{"],
		["wrong version", JSON.stringify({ v: 2, providers: {} })],
		["unknown field", JSON.stringify({ v: 1, providers: {}, extra: true })],
		["unknown custody", JSON.stringify({ v: 1, providers: { p: { custody: "cloud" } } })],
		["bad url part", JSON.stringify({ v: 1, providers: { p: { secretUrlParts: ["urlPath:-1"] } } })],
		["zero ttl", JSON.stringify({ v: 1, providers: { p: { apiKeyTtlSeconds: 0 } } })],
	])("reports %s as invalid, never as absent or ok", async (_name, text) => {
		await writeFile(custodySidecarPath(dir), text);
		expect((await readCustodySidecar(custodySidecarPath(dir))).state).toBe("invalid");
	});
});

describe("custody.json atomic writer", () => {
	it("round-trips through the reader", async () => {
		await writeCustodySidecar(custodySidecarPath(dir), SIDECAR);
		expect(await readCustodySidecar(custodySidecarPath(dir))).toEqual({ state: "ok", sidecar: SIDECAR });
	});

	it("writes owner-only and leaves no temp file behind", async () => {
		await writeCustodySidecar(custodySidecarPath(dir), SIDECAR);
		await writeCustodySidecar(custodySidecarPath(dir), { v: 1, providers: {} });
		expect((await stat(custodySidecarPath(dir))).mode & 0o777).toBe(0o600);
		expect(await readdir(dir)).toEqual(["custody.json"]);
		expect(JSON.parse(await readFile(custodySidecarPath(dir), "utf8"))).toEqual({ v: 1, providers: {} });
	});

	it("refuses to write a sidecar its own reader would reject", async () => {
		const invalid = JSON.parse('{"v":1,"providers":{"p":{"custody":"cloud"}}}');
		await expect(writeCustodySidecar(custodySidecarPath(dir), invalid)).rejects.toThrow(TypeError);
		expect(await readdir(dir)).toEqual([]);
	});
});

describe("fused assembly", () => {
	it.each(["cli.ts", "main.ts", "index.ts", "core/sdk.ts"])("%s never reaches the sidecar module", (entry) => {
		const closure = valueImportClosure(join(SRC, entry));
		expect(closure.size).toBeGreaterThan(1);
		expect(closure.has(join(SRC, "core/egress/custody-sidecar.ts"))).toBe(false);
	});
});
