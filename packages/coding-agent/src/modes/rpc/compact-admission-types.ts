import type { AdmissionProducerLifetime } from "./compact-admission-producer.ts";
import type { AdmissionRow } from "./compact-admission-storage.ts";

export type Answer = Readonly<Record<string, unknown>>;
export type AdmissionIdentity = {
	readonly socketEpoch: string;
	readonly peer: string;
	readonly admissionId: string;
	readonly fingerprint: string;
	/** RULING-125: the request carried `retry: true` (a C4.4 resend); never part of the fingerprint. */
	readonly retry?: boolean;
};
export type Produced = {
	readonly answer: Answer;
	readonly release: () => Promise<void>;
	readonly activate?: () => void;
	readonly refusal?: () => Answer | undefined;
};
export type Epoch = {
	readonly producer: AdmissionProducerLifetime;
	readonly peer: string;
	readonly directory: Promise<string>;
	readonly hot: Map<string, ReturnType<typeof Promise.withResolvers<Answer>>>;
	readonly failures: Map<string, AdmissionRow>;
	/** Terminal row keys to their admission IDs, least recently used first. */
	readonly done: Map<string, string>;
	/** Digests of evicted IDs, oldest first. */
	readonly retired: Set<string>;
	tail: Promise<void>;
	ended: boolean;
	waiting: number;
};
