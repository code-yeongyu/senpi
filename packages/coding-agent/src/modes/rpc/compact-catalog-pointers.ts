import { z } from "zod";
import { catalogDigest, storedBytes } from "./compact-catalog-codec.ts";
import { COMPACT_LEAF_CODE_UNITS, type LeafId } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { type ContentDigest, parseContentDigest } from "./compact-recovery-ids.ts";

/**
 * A catalog node's private pointers: where each child's stored bytes live. Never part of a node's hashed bytes and
 * never sent. The list is a tree of side leaves, each at most `COMPACT_LEAF_CODE_UNITS` (32,768 code units, 64 KiB
 * stored), however many children or component leaves it names:
 *
 * - a height-0 leaf `{"h":0,"v":[...]}` holds tokens in child order: a node child `{"n":node,"s":side,"d":digest}`,
 *   or a component header `{"c":count}` followed by its `count` leaf ids, which may continue in the next leaf;
 * - a height-h leaf `{"h":h,"v":[{"s":side,"d":digest},...]}` lists the height h-1 leaves below it in order.
 *
 * Every side leaf is checked against its `pointer`-domain digest (recorded by its parent leaf, the parent node's
 * pointers or the root) before decode, so a changed or stale pointer is `integrity`. The writer keeps one open leaf
 * per height and the reader one decoded leaf per height: no pointer list is ever one string.
 */
export interface PointerHead {
	readonly side: LeafId;
	readonly digest: ContentDigest;
}

type Pointer =
	| { readonly kind: "node"; readonly node: LeafId; readonly head: PointerHead }
	| { readonly kind: "component"; readonly leaves: readonly LeafId[] };

interface OpenLeaf {
	readonly tokens: string[];
	units: number;
}

const openLeaf = (height: number): OpenLeaf => ({ tokens: [], units: `{"h":${height},"v":[]}`.length });
const headToken = (head: PointerHead): string => `{"s":${head.side},"d":"${head.digest}"}`;

export class CatalogPointerWriter {
	private readonly open: OpenLeaf[] = [];
	private readonly create: (text: string) => LeafId;

	constructor(create: (text: string) => LeafId) {
		this.create = create;
	}

	node(node: LeafId, head: PointerHead): void {
		this.push(0, `{"n":${node},"s":${head.side},"d":"${head.digest}"}`);
	}

	component(leaves: readonly LeafId[]): void {
		this.push(0, `{"c":${leaves.length}}`);
		for (const leaf of leaves) this.push(0, String(leaf));
	}

	finish(): PointerHead {
		this.level(0);
		for (let height = 0; ; height++) {
			if (height === this.open.length - 1) return this.seal(height);
			this.push(height + 1, headToken(this.seal(height)));
		}
	}

	private level(height: number): OpenLeaf {
		return this.open[height] ?? (this.open[height] = openLeaf(height));
	}

	private push(height: number, token: string): void {
		const open = this.level(height);
		const units = open.units + token.length + Number(open.tokens.length > 0);
		if (units > COMPACT_LEAF_CODE_UNITS) {
			this.push(height + 1, headToken(this.seal(height)));
			return this.push(height, token);
		}
		open.tokens.push(token);
		open.units = units;
	}

	private seal(height: number): PointerHead {
		const text = `{"h":${height},"v":[${this.level(height).tokens.join(",")}]}`;
		this.open[height] = openLeaf(height);
		const side = this.create(text);
		return { side, digest: catalogDigest("pointer", storedBytes(text)) };
	}
}

const Id = z.number().int().positive();
const SideLeafSchema = z.object({ h: z.number().int().nonnegative(), v: z.array(z.unknown()) }).strict();
const DataSchema = z.array(
	z.union([
		Id,
		z.object({ c: z.number().int().nonnegative() }).strict(),
		z.object({ n: Id, s: Id, d: z.string() }).strict(),
	]),
);
const IndexSchema = z.array(z.object({ s: Id, d: z.string() }).strict()).min(1);
type DataToken = z.infer<typeof DataSchema>[number];

const corrupt = (): CompactReadError => new CompactReadError("integrity");

function digest(raw: string): ContentDigest {
	const parsed = parseContentDigest(raw);
	if (!parsed.ok) throw corrupt();
	return parsed.value;
}

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw corrupt();
	return parsed.data;
}

async function* tokens(
	read: (side: LeafId) => Promise<string>,
	head: PointerHead,
	height?: number,
): AsyncGenerator<DataToken> {
	const text = await read(head.side);
	if (catalogDigest("pointer", storedBytes(text)) !== head.digest) throw corrupt();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (cause) {
		if (cause instanceof SyntaxError) throw corrupt();
		throw cause;
	}
	const leaf = decode(SideLeafSchema, json);
	if (height !== undefined && leaf.h !== height) throw corrupt();
	if (leaf.h === 0) {
		yield* decode(DataSchema, leaf.v);
		return;
	}
	for (const below of decode(IndexSchema, leaf.v))
		yield* tokens(read, { side: below.s, digest: digest(below.d) }, leaf.h - 1);
}

/** The pointer of child `step`, or `undefined` past the last child; a malformed list is `integrity`. */
export async function catalogPointer(
	read: (side: LeafId) => Promise<string>,
	head: PointerHead,
	step: number,
): Promise<Pointer | undefined> {
	let child = 0;
	let skip = 0;
	let wanted = 0;
	let leaves: LeafId[] | undefined;
	for await (const token of tokens(read, head)) {
		if (leaves || skip > 0) {
			if (typeof token !== "number") throw corrupt();
			if (!leaves) skip--;
			else if (leaves.push(token) === wanted) return { kind: "component", leaves };
			continue;
		}
		if (typeof token === "number") throw corrupt();
		const here = child++;
		if ("n" in token) {
			if (here === step) return { kind: "node", node: token.n, head: { side: token.s, digest: digest(token.d) } };
		} else if (here !== step) skip = token.c;
		else if (token.c === 0) return { kind: "component", leaves: [] };
		else {
			leaves = [];
			wanted = token.c;
		}
	}
	if (leaves || skip > 0) throw corrupt();
	return undefined;
}
