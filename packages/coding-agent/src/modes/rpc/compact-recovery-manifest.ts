import { checkpointComponents } from "./compact-catalog-families.ts";
import { COMPACT_LEAF_CODE_UNITS, type CompactContentStore, type LeafId } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { producePage, type RecoveryPage } from "./compact-recovery-bytes.ts";
import {
	type CatalogComponent,
	type CatalogRead,
	type CatalogRoot,
	CompactRecoveryCatalog,
} from "./compact-recovery-catalog.ts";
import {
	type BoundedId,
	catalogRootRef,
	childRef,
	type ContentDigest,
	type ContentRef,
	parseBoundedId,
	parseContentRef,
	protocolId,
} from "./compact-recovery-ids.ts";
import type { CheckpointToken, RecoveryRouteKind } from "./compact-recovery-types.ts";
import { CompactValues } from "./compact-values.ts";
import { VerifiedComponents } from "./compact-verified-components.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "./session-acceptance-lane.ts";

/** A manifest string: inline when it is a bounded protocol id, otherwise a ref to its exact stored value. */
type ManifestText =
	| { readonly id: BoundedId }
	| { readonly ref: ContentRef; readonly length: number; readonly digest: ContentDigest };

/**
 * The compact-v1 manifest (R4.B1): bounded scalar identity of one frozen checkpoint and the root of its catalog;
 * never the checkpoint or a list of its components. Every id is generated and bounded; a session id or transcript
 * id a user chose becomes a ref (RULING-57 Q2 (2)) and reads back exactly through the catalog.
 */
export interface RecoveryManifest {
	readonly format: "senpi-recovery-manifest";
	readonly version: 1;
	readonly socketEpoch: ManifestText;
	readonly admissionId: ManifestText;
	readonly routeKind: RecoveryRouteKind;
	readonly session: ManifestText;
	readonly sessionEpoch: ManifestText;
	readonly generation: number;
	readonly sequence: number;
	readonly historyVersion: number;
	readonly token: ManifestText;
	readonly leaf: ManifestText | null;
	readonly activeMessage: ManifestText | null;
	readonly turn: ManifestText | null;
	readonly checkpointDigest: ContentDigest;
	readonly catalogRoot: ContentRef;
	readonly catalogRootLength: number;
}

const TEXT_FIELDS = [
	"socketEpoch",
	"admissionId",
	"session",
	"sessionEpoch",
	"token",
	"leaf",
	"activeMessage",
	"turn",
] as const;
type TextField = (typeof TEXT_FIELDS)[number];
const MANIFEST = protocolId("manifest");

interface Built {
	readonly manifest: RecoveryManifest;
	readonly root: CatalogRoot;
	readonly store: CompactContentStore;
}

const chunks = (value: string): string[] => {
	const parts: string[] = [];
	for (let start = 0; start < value.length; start += COMPACT_LEAF_CODE_UNITS)
		parts.push(value.slice(start, start + COMPACT_LEAF_CODE_UNITS));
	return parts;
};

/**
 * One manifest and catalog per token, built once from the pinned root and released with the token. A component is
 * verified once per frozen root (RULING-69 (2)): every later page or re-open on that root reuses the verified source,
 * and the entry is dropped with the token's lease. A source holds leaf positions, never bytes; S11b owns the
 * current-page retry cache.
 */
export class RecoveryManifests {
	private readonly catalogs = new CompactRecoveryCatalog();
	private readonly building = new Map<string, Promise<Built>>();
	private readonly ready = new Map<string, Built>();
	private readonly verified = new VerifiedComponents();
	private counter = 0;

	manifest(
		token: CheckpointToken,
		lane: SessionAcceptanceLane,
		root: FrozenAcceptedRoot,
		valid: () => void,
	): Promise<RecoveryManifest> {
		let pending = this.building.get(token.id);
		if (!pending) {
			pending = this.build(token, lane, root, valid);
			this.building.set(token.id, pending);
			pending.then(
				(built) => this.ready.set(token.id, built),
				() => this.building.delete(token.id),
			);
		}
		return pending.then((built) => built.manifest);
	}

	/** A raw ref is validated before any use; without a built catalog no ref can name anything. */
	read(tokenId: string, lane: SessionAcceptanceLane, root: FrozenAcceptedRoot, ref: string): Promise<CatalogRead> {
		const parsed = parseContentRef(ref);
		const built = this.ready.get(tokenId);
		if (!parsed.ok || !built) throw new CompactReadError("range");
		return lane.cutStorage(root, (store, valid) => this.catalogs.read(store, built.root, parsed.value, valid));
	}

	get verifiedComponents(): number {
		return this.verified.size;
	}

	/**
	 * One page of a component's bytes at a raw byte offset; a ref that names a node or nothing is `range`. A first open
	 * verifies the component inside this request under its `signal`; it is cached only while the token still holds it.
	 */
	page(
		tokenId: string,
		lane: SessionAcceptanceLane,
		root: FrozenAcceptedRoot,
		ref: string,
		offset: number,
		signal?: AbortSignal,
	): Promise<RecoveryPage> {
		const parsed = parseContentRef(ref);
		const built = this.ready.get(tokenId);
		if (!parsed.ok || !built) throw new CompactReadError("range");
		return lane.cutStorage(root, async (store, valid) => {
			let bytes = this.verified.get(tokenId, parsed.value);
			if (!bytes) {
				const read = await this.catalogs.read(store, built.root, parsed.value, valid, signal);
				if (read.kind !== "component") throw new CompactReadError("range");
				bytes = read.bytes;
				if (this.ready.get(tokenId) === built) this.verified.set(tokenId, read.ref, bytes);
			}
			return producePage(bytes, offset, valid);
		});
	}

	release(tokenId: string): void {
		const built = this.ready.get(tokenId);
		this.ready.delete(tokenId);
		this.building.delete(tokenId);
		this.verified.drop(tokenId);
		if (built) this.catalogs.release(built.store, built.root);
	}

	private build(
		token: CheckpointToken,
		lane: SessionAcceptanceLane,
		root: FrozenAcceptedRoot,
		valid: () => void,
	): Promise<Built> {
		const ref = catalogRootRef(++this.counter);
		const strings: Readonly<Record<TextField, string | null>> = {
			socketEpoch: token.admission.socketEpoch,
			admissionId: token.admission.admissionId,
			session: token.admission.sessionId,
			sessionEpoch: token.admission.sessionEpoch,
			token: token.id,
			leaf: token.cut.leafId,
			activeMessage: token.cut.activeMessageId,
			turn: token.cut.turnId,
		};
		return lane.cutStorage(root, async (store, cutValid) => {
			const texts = new Map<TextField, ManifestText | null>();
			const oversized: { readonly field: TextField; readonly component: CatalogComponent }[] = [];
			const owned: LeafId[] = [];
			for (const field of TEXT_FIELDS) {
				const value = strings[field];
				if (value === null) {
					texts.set(field, null);
					continue;
				}
				const bounded = parseBoundedId(value);
				if (bounded.ok) {
					texts.set(field, { id: bounded.value });
					continue;
				}
				const leaves = chunks(value).map((chunk) => store.createLeaf(chunk));
				owned.push(...leaves);
				const component = { kind: MANIFEST, id: protocolId(field), leaves, owner: store.text.own(leaves) };
				oversized.push({ field, component });
			}
			try {
				const check = () => {
					cutValid();
					valid();
				};
				const cut = { store, values: new CompactValues(store), root, settled: lane.settledOf(root) };
				const components = async function* () {
					yield* oversized.map(({ component }) => component);
					yield* checkpointComponents(cut, check);
				};
				const built = await this.catalogs.build(store, ref, components(), check);
				return await this.assemble(store, token, ref, built, oversized, texts);
			} finally {
				for (const { component } of oversized) store.adjust(component.owner, -1, 0);
				for (const leaf of owned) store.adjust(leaf, -1, 0);
			}
		});
	}

	/** Owns `built` from here: a failure anywhere below releases the tree, so no owner outlives a refused build. */
	private async assemble(
		store: CompactContentStore,
		token: CheckpointToken,
		ref: ContentRef,
		built: CatalogRoot,
		oversized: readonly { readonly field: TextField; readonly component: CatalogComponent }[],
		texts: Map<TextField, ManifestText | null>,
	): Promise<Built> {
		try {
			let leftmost = ref;
			for (let level = 1; level < built.depth; level++) leftmost = childRef(leftmost, 0);
			const node = oversized.length ? await this.catalogs.read(store, built, leftmost) : undefined;
			for (const [index, { field, component }] of oversized.entries()) {
				const entry = node?.kind === "node" ? node.entries[index] : undefined;
				// The oversized components went in first, so they are the leftmost leaf's first entries in field order;
				// any other layout is this builder's own invariant broken, refused as a typed internal error.
				if (!entry || entry.kind !== component.kind || entry.id !== component.id)
					throw new CompactReadError("ownership");
				texts.set(field, { ref: childRef(leftmost, index), length: entry.length, digest: entry.digest });
			}
			const text = (field: TextField): ManifestText | null => {
				const value = texts.get(field);
				if (value === undefined) throw new CompactReadError("ownership");
				return value;
			};
			const required = (field: TextField): ManifestText => text(field) ?? raise();
			const manifest: RecoveryManifest = {
				format: "senpi-recovery-manifest",
				version: 1,
				socketEpoch: required("socketEpoch"),
				admissionId: required("admissionId"),
				routeKind: token.admission.routeKind,
				session: required("session"),
				sessionEpoch: required("sessionEpoch"),
				generation: token.admission.generation,
				sequence: token.cut.sequence,
				historyVersion: token.cut.historyVersion,
				token: required("token"),
				leaf: text("leaf"),
				activeMessage: text("activeMessage"),
				turn: text("turn"),
				checkpointDigest: built.digest,
				catalogRoot: ref,
				catalogRootLength: built.length,
			};
			return { manifest, root: built, store };
		} catch (cause) {
			this.catalogs.release(store, built);
			throw cause;
		}
	}
}

function raise(): never {
	throw new CompactReadError("ownership");
}
