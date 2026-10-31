import type { FileEntry } from "./session-manager.ts";
import {
	captureTranscriptBase,
	type FileIdentity,
	type PersistedBase,
	type TranscriptUnavailableReason,
} from "./session-transcript-journal.ts";

/** One lifecycle's identity and optional loaded base. A superseded asynchronous capture cannot publish. */
export class TranscriptFile {
	base: PersistedBase | null = null;
	history = 0;
	identity: FileIdentity | undefined;
	unavailable: TranscriptUnavailableReason | undefined;
	ready: Promise<void> = Promise.resolve();
	private generation = 0;

	reset(): void {
		this.generation++;
		this.base = null;
		this.history = 0;
		this.identity = undefined;
		this.unavailable = undefined;
		this.ready = Promise.resolve();
	}

	capture(
		identity: Promise<FileIdentity | undefined>,
		entries: readonly FileEntry[] | undefined,
		publish: () => void,
	): void {
		this.reset();
		const generation = this.generation;
		const captured = entries ? captureTranscriptBase(entries) : undefined;
		this.ready = identity.then((fileIdentity) => {
			if (generation !== this.generation) return;
			if (!fileIdentity) this.unavailable = "transcript_file_identity_unavailable";
			else {
				this.identity = fileIdentity;
				if (captured) {
					this.base = { fileIdentity, count: captured.count, idFingerprint: captured.idFingerprint };
					this.history = captured.history;
				}
			}
			publish();
		});
	}
}
