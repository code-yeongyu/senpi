import type {
	SessionMetadata,
	SessionReader,
	SessionSearch,
	SessionSearchHit,
	SessionSearchOptions,
} from "../types.ts";
import { findSessionEntryMatches } from "./repository.ts";

type SessionSearchSource<TMetadata extends SessionMetadata> = {
	load(metadata: TMetadata): Promise<SessionReader<TMetadata>>;
	list(): Promise<TMetadata[]>;
};

/** Searches canonical sessions directly and therefore has no index to maintain. */
class ScanningSessionSearch<TMetadata extends SessionMetadata = SessionMetadata> implements SessionSearch<TMetadata> {
	private readonly source: SessionSearchSource<TMetadata>;

	constructor(source: SessionSearchSource<TMetadata>) {
		this.source = source;
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const hits: SessionSearchHit<TMetadata>[] = [];
		for (const metadata of await this.source.list()) {
			const cwd = (metadata as { cwd?: unknown }).cwd;
			if (options.cwd !== undefined && cwd !== options.cwd) continue;
			const reader = await this.source.load(metadata);
			hits.push(...findSessionEntryMatches(reader.metadata, await reader.readEntries(), options.text));
		}
		return hits;
	}
}

export function createScanningSessionSearch<TMetadata extends SessionMetadata>(
	source: SessionSearchSource<TMetadata>,
): SessionSearch<TMetadata> {
	return new ScanningSessionSearch(source);
}
