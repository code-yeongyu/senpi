import type { AdmissionProducerLifetime } from "./compact-admission-producer.ts";

export type Answer = Readonly<Record<string, unknown>>;
export type AdmissionIdentity = {
	readonly socketEpoch: string;
	readonly peer: string;
	readonly admissionId: string;
	readonly fingerprint: string;
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
	tail: Promise<void>;
	entries: number;
	ended: boolean;
	waiting: number;
};
