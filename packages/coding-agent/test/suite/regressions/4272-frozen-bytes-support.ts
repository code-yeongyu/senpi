import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { CatalogRead } from "../../../src/modes/rpc/compact-recovery-catalog.ts";

/** A component read as the catalog returns it since S11a: a byte source, never the joined text. */
export type ComponentRead = Extract<CatalogRead, { kind: "component" }>;

export const component = (read: CatalogRead): ComponentRead =>
	read.kind === "component" ? read : expect.unreachable("expected a component");

/** The written spec of `compact-catalog-codec.ts`, restated so no expected digest comes from the encoder. */
export const specDigest = (domain: "leaf" | "node" | "root" | "fragment", bytes: Buffer): string => {
	const tag = Buffer.from(`senpi-recovery-catalog/1/utf16le/${domain}`, "ascii");
	const length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	return createHash("sha256")
		.update(Buffer.from([tag.length]))
		.update(tag)
		.update(length)
		.update(bytes)
		.digest("hex");
};

/** The exact stored bytes of a component, read range by range (a test-side join the production path never makes). */
export async function componentBytes(read: ComponentRead, step = 131_072): Promise<Buffer> {
	const parts: Buffer[] = [];
	for (let offset = 0; offset < read.bytes.length; offset += step)
		parts.push(await read.bytes.range(offset, Math.min(step, read.bytes.length - offset)));
	return Buffer.concat(parts);
}

export const componentText = async (read: ComponentRead): Promise<string> =>
	(await componentBytes(read)).toString("utf16le");
