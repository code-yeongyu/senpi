import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import { COMPACT_LEAF_CODE_UNITS } from "./compact-content-store.ts";
import {
	type BoundedId,
	CATALOG_NODE_MAX_ENTRIES,
	type ContentDigest,
	parseBoundedId,
	parseContentDigest,
} from "./compact-recovery-ids.ts";

/**
 * The one frozen-reference codec of the recovery catalog (S09-Q1 A, RULING-57 Q1; shared by S11a/S12a/S13 per
 * RULING-46 item 2).
 *
 * Digest: SHA-256 over `u8 tagLength || tag || u64be byteLength || bytes`, where `tag` is the ASCII
 * `senpi-recovery-catalog/<version>/<encoding>/<domain>`: `encoding` names the stored encoding of the hashed bytes
 * (`utf16le`, RULING-58 (1): a store that writes another encoding gets its own tag and never collides) and `domain`
 * is `leaf` (one component's stored bytes), `node` (a catalog node as a child), `root` (the catalog root named by
 * the manifest) or `pointer` (a node's private side leaf, `compact-catalog-pointers.ts`). Bytes are the EXACT stored bytes of the content store: the UTF-16LE code units of the leaf text,
 * a lone surrogate included, never a reconstructed or transcoded value. A format bump changes `CATALOG_VERSION`,
 * hence every tag; a retired prefix is never reused.
 *
 * Node: one JSON text with this fixed field order and no other field, integers in canonical decimal, entries in
 * child order; every string is an allow-listed ASCII identifier, so the encoding is deterministic by construction.
 */
export const CATALOG_FORMAT = "senpi-recovery-catalog";
export const CATALOG_VERSION = 1;
/** The one encoding `storedBytes` writes and every tag names (`compact-content-store.ts` `flushLeaf`). */
const CATALOG_ENCODING = "utf16le" satisfies BufferEncoding;
/** A node is one store leaf: 32,768 UTF-16 code units, 64 KiB stored, under D (131,072) and F. */
export const CATALOG_NODE_MAX_UNITS = COMPACT_LEAF_CODE_UNITS;

type CatalogDomain = "leaf" | "node" | "root" | "pointer";

export interface CatalogEntry {
	readonly kind: BoundedId;
	readonly id: BoundedId;
	readonly length: number;
	readonly digest: ContentDigest;
}

export const storedBytes = (text: string): Buffer => Buffer.from(text, CATALOG_ENCODING);

/** A digest over `length` bytes fed in order; `finish` after exactly that many. */
export function catalogDigester(
	domain: CatalogDomain,
	length: number,
): { update(bytes: Buffer): void; finish(): ContentDigest } {
	const tag = Buffer.from(`${CATALOG_FORMAT}/${CATALOG_VERSION}/${CATALOG_ENCODING}/${domain}`, "ascii");
	const prefix = Buffer.alloc(1 + tag.length + 8);
	prefix.writeUInt8(tag.length, 0);
	tag.copy(prefix, 1);
	prefix.writeBigUInt64BE(BigInt(length), 1 + tag.length);
	const hash: Hash = createHash("sha256").update(prefix);
	let fed = 0;
	return {
		update: (bytes) => {
			fed += bytes.length;
			hash.update(bytes);
		},
		finish: () => {
			if (fed !== length) throw new RangeError(`catalog digest fed ${fed} of ${length} bytes`);
			const parsed = parseContentDigest(hash.digest("hex"));
			if (!parsed.ok) throw new RangeError("sha256 produced a malformed digest");
			return parsed.value;
		},
	};
}

export function catalogDigest(domain: CatalogDomain, bytes: Buffer): ContentDigest {
	const digester = catalogDigester(domain, bytes.length);
	digester.update(bytes);
	return digester.finish();
}

const HEAD = `{"format":"${CATALOG_FORMAT}","version":${CATALOG_VERSION},"entries":[`;
const TAIL = "]}";
const encodeEntry = (entry: CatalogEntry): string =>
	`{"kind":"${entry.kind}","id":"${entry.id}","length":${entry.length},"digest":"${entry.digest}"}`;

/** Packs entries in order; `push` refuses, without retaining, the entry that would exceed either bound. */
export class CatalogNodeWriter {
	private readonly parts: string[] = [];
	private units = HEAD.length + TAIL.length;

	get count(): number {
		return this.parts.length;
	}

	push(entry: CatalogEntry): boolean {
		if (!Number.isSafeInteger(entry.length) || entry.length < 0) throw new RangeError("catalog entry length");
		const part = encodeEntry(entry);
		const units = this.units + part.length + Number(this.parts.length > 0);
		if (this.parts.length === CATALOG_NODE_MAX_ENTRIES || units > CATALOG_NODE_MAX_UNITS) return false;
		this.parts.push(part);
		this.units = units;
		return true;
	}

	encode(): string {
		return `${HEAD}${this.parts.join(",")}${TAIL}`;
	}
}

const CatalogNodeSchema = z
	.object({
		format: z.literal(CATALOG_FORMAT),
		version: z.literal(CATALOG_VERSION),
		entries: z
			.array(
				z
					.object({ kind: z.string(), id: z.string(), length: z.number().int().nonnegative(), digest: z.string() })
					.strict(),
			)
			.max(CATALOG_NODE_MAX_ENTRIES),
	})
	.strict();

type CatalogDecode =
	| { readonly ok: true; readonly entries: readonly CatalogEntry[] }
	| { readonly ok: false; readonly reason: "schema" };

/** Decodes verified node bytes only: the caller checks the digest first (RULING-57 Q1 (3)). */
export function decodeCatalogNode(text: string): CatalogDecode {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (cause) {
		if (cause instanceof SyntaxError) return { ok: false, reason: "schema" };
		throw cause;
	}
	const parsed = CatalogNodeSchema.safeParse(json);
	if (!parsed.success) return { ok: false, reason: "schema" };
	const entries: CatalogEntry[] = [];
	for (const raw of parsed.data.entries) {
		const kind = parseBoundedId(raw.kind);
		const id = parseBoundedId(raw.id);
		const digest = parseContentDigest(raw.digest);
		if (!kind.ok || !id.ok || !digest.ok) return { ok: false, reason: "schema" };
		entries.push({ kind: kind.value, id: id.value, length: raw.length, digest: digest.value });
	}
	return { ok: true, entries };
}
