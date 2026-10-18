import { createHash } from "node:crypto";
import { z } from "zod";
import { clientMessageIdentitySchema } from "../../core/client-message-identity.ts";
import { effectOutcomeSchema } from "./effect-record.ts";
import type { RpcCommand } from "./rpc-types.ts";

export const CLIENT_ADMISSION_ENTRY = "rpc_client_message_admission";
/** Prefix of a `clientMessageId` the host minted for an id-less queued input; never shown to a client as its own. */
export const HOST_MINTED_ID_PREFIX = "host:";

export function isHostMintedId(id: string | undefined): boolean {
	return id?.startsWith(HOST_MINTED_ID_PREFIX) === true;
}

/** The identity a client may see: a host-minted `clientMessageId` is internal and dropped. */
export function clientFacingIdentity<T extends { readonly clientMessageId?: string }>(value: T): T {
	if (!isHostMintedId(value.clientMessageId)) return value;
	const { clientMessageId: _minted, ...rest } = value;
	return rest as T;
}
export const DURABLE_CLIENT_MESSAGE_ID_CAPABILITY = "durable_client_message_id";
export type RpcClientInput = Extract<RpcCommand, { type: "prompt" | "steer" | "follow_up" }>;

const admissionIdentitySchema = clientMessageIdentitySchema.extend({
	clientMessageId: z.string().min(1).max(256),
	durableSessionId: z.string(),
	fingerprint: z.string(),
	disposition: z.enum(["queued", "started", "handled"]),
	/** The host minted `clientMessageId` for input sent without one (`host:<durableSessionId>:<uuid>`). */
	hostMinted: z.literal(true).optional(),
});

const preparedInputSchema = clientMessageIdentitySchema.extend({
	text: z.string(),
	images: z.array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })).optional(),
	mode: z.enum(["steer", "followUp"]),
	enqueueOrder: z.number(),
});

export const clientAdmissionRecordSchema = z.discriminatedUnion("state", [
	admissionIdentitySchema.extend({ state: z.literal("queued"), prepared: preparedInputSchema }),
	admissionIdentitySchema.extend({ state: z.literal("running"), prepared: z.undefined().optional() }),
	// `outcome` is additive: an older host strips it and still reads the record as completed.
	admissionIdentitySchema.extend({
		state: z.literal("completed"),
		prepared: z.undefined().optional(),
		outcome: effectOutcomeSchema.optional(),
	}),
]);

export type ClientAdmissionRecord = z.infer<typeof clientAdmissionRecordSchema>;
export type ClientMessageAdmission = Omit<ClientAdmissionRecord, "fingerprint" | "prepared">;

export function admissionSnapshot(record: ClientAdmissionRecord): ClientMessageAdmission {
	const { fingerprint: _fingerprint, prepared: _prepared, ...snapshot } = record;
	return snapshot;
}

export class ClientMessageIdConflict extends Error {
	readonly code = "client_message_id_conflict";
	readonly clientMessageId: string;

	constructor(clientMessageId: string) {
		super(`client_message_id_conflict: ${clientMessageId}`);
		this.name = "ClientMessageIdConflict";
		this.clientMessageId = clientMessageId;
	}
}

export function clientInputFingerprint(command: RpcClientInput): string {
	const payload = {
		type: command.type,
		message: command.message,
		images: command.images?.map(({ type, data, mimeType }) => ({ type, data, mimeType })) ?? [],
		clientTurnId: command.clientTurnId,
		...(command.type === "prompt"
			? {
					streamingBehavior: command.streamingBehavior,
					thinkingLevel: command.thinkingLevel,
					sessionTitlePrompt: command.sessionTitlePrompt,
					expandPromptTemplates: command.expandPromptTemplates ?? true,
					unknownCommandAsText: command.unknownCommandAsText ?? false,
				}
			: {}),
	};
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
