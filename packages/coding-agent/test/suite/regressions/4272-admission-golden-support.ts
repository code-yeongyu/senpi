import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { catalogDigest } from "../../../src/modes/rpc/compact-catalog-codec.ts";

export const admissionFixtures = new URL("../../../docs/engine-socket/fixtures/admission-routes/", import.meta.url);

/** Normalize run paths/identities, not routing fields or frame kinds. Pages stay decodable and digest-valid:
 * verify the REAL producer digest first, normalize the UTF-16 JSON content, then update its length/digest.
 * Digests naming unshipped catalog components are stable opaque aliases, not fabricated component payloads.
 */
export function normalizedTrace(input: unknown, root: string): unknown {
	const ids = new Map<string, string>();
	const digests = new Map<string, string>();
	const entries = new Map<string, string>();
	const pages = new Map<string, Buffer>();
	const text = (value: string): string =>
		value
			.replaceAll(root, "<root>")
			.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
				if (!ids.has(id)) ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
				return ids.get(id) ?? id;
			})
			.replace(/faux:[^"]+/g, "faux:fixture")
			.replace(/\b[0-9a-f]{64}\b/g, (digest) => {
				if (!digests.has(digest))
					digests.set(digest, createHash("sha256").update(`fixture-${digests.size}`).digest("hex"));
				return digests.get(digest) ?? digest;
			});
	const visit = (value: unknown, key?: string): unknown => {
		if (typeof value === "string") {
			if (key !== undefined && ["id", "parentId", "leafId"].includes(key) && /^[0-9a-f]{8}$/.test(value)) {
				if (!entries.has(value)) entries.set(value, (entries.size + 1).toString(16).padStart(8, "0"));
				return entries.get(value);
			}
			return text(value);
		}
		if (Array.isArray(value)) return value.map((item: unknown) => visit(item));
		if (typeof value !== "object" || value === null) return value;
		const record = value as Record<string, unknown>;
		if (typeof record.bytes === "string" && typeof record.digest === "string" && typeof record.length === "number") {
			const raw = Buffer.from(record.bytes, "base64");
			expect(raw.length).toBe(record.length);
			expect(catalogDigest("fragment", raw)).toBe(record.digest);
			const body: unknown = JSON.parse(raw.toString("utf16le"));
			const bytes = Buffer.from(JSON.stringify(visit(body)), "utf16le");
			const lease = record.lease as { id?: string } | undefined;
			if (record.complete === true && record.offset === 0 && lease?.id !== undefined) pages.set(lease.id, bytes);
			const { bytes: _bytes, digest: _digest, length: _length, ...metadata } = record;
			return {
				...(visit(metadata) as Record<string, unknown>),
				length: bytes.length,
				digest: catalogDigest("fragment", bytes),
				bytes: bytes.toString("base64"),
			};
		}
		return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item, key)]));
	};
	const repairLease = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map((item: unknown) => repairLease(item));
		if (typeof value !== "object" || value === null) return value;
		const record = value as Record<string, unknown>;
		const bytes = record.kind === "event" && typeof record.id === "string" ? pages.get(record.id) : undefined;
		if (bytes && "length" in record && "digest" in record)
			return { ...record, length: bytes.length, digest: catalogDigest("leaf", bytes) };
		return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, repairLease(item)]));
	};
	return repairLease(visit(input));
}

export async function compareAdmissionGoldens(cases: Readonly<Record<string, unknown>>, root: string): Promise<void> {
	const captured = Object.fromEntries(
		Object.entries(cases).map(([name, value]) => [name, normalizedTrace(value, root)]),
	);
	if (process.env.SENPI_PRINT_ADMISSION_GOLDEN === "1")
		for (const [name, value] of Object.entries(captured))
			console.log(`ADMISSION_GOLDEN ${JSON.stringify({ name, value })}`);
	const index = JSON.parse(await readFile(new URL("index.json", admissionFixtures), "utf8")) as { cases: string[] };
	for (const [name, value] of Object.entries(captured)) {
		expect(index.cases).toContain(name);
		expect(JSON.parse(await readFile(new URL(name, admissionFixtures), "utf8"))).toEqual(value);
	}
	// Every head publishes a self-consistent, parseable index; h is never regenerated here.
	for (const name of index.cases) JSON.parse(await readFile(new URL(name, admissionFixtures), "utf8"));
}
