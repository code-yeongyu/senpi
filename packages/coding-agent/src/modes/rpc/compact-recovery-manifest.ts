import { checkpointComponents } from "./compact-catalog-families.ts";
import { COMPACT_LEAF_CODE_UNITS, type CompactContentStore, type LeafId } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
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

/** One manifest and catalog per token, built once from the pinned root and released with the token. */
export class RecoveryManifests {
	private readonly catalogs = new CompactRecoveryCatalog();
	private readonly building = new Map<string, Promise<Built>>();
	private readonly ready = new Map<string, Built>();
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
		return lane.cutStorage(root, (store) => this.catalogs.read(store, built.root, parsed.value));
	}

	release(tokenId: string): void {
		const built = this.ready.get(tokenId);
		this.ready.delete(tokenId);
		this.building.delete(tokenId);
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
			const oversized: TextField[] = [];
			const owned: LeafId[] = [];
			const components: CatalogComponent[] = [];
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
				components.push({ kind: MANIFEST, id: protocolId(field), leaves, owner: store.text.own(leaves) });
				oversized.push(field);
			}
			try {
				const check = () => {
					cutValid();
					valid();
				};
				const built = await this.catalogs.build(store, ref, [...components, ...checkpointComponents(root)], check);
				let leftmost = ref;
				for (let level = 1; level < built.depth; level++) leftmost = childRef(leftmost, 0);
				const node = oversized.length ? await this.catalogs.read(store, built, leftmost) : undefined;
				for (const [index, field] of oversized.entries()) {
					const entry = node?.kind === "node" ? node.entries[index] : undefined;
					if (!entry) throw new CompactReadError("ownership");
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
			} finally {
				for (const component of components) store.adjust(component.owner, -1, 0);
				for (const leaf of owned) store.adjust(leaf, -1, 0);
			}
		});
	}
}

function raise(): never {
	throw new CompactReadError("ownership");
}
