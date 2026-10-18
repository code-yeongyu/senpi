import type { ImageContent } from "@earendil-works/pi-ai";
import { z } from "zod";

export const clientMessageIdentitySchema = z.object({
	clientMessageId: z.string().min(1).max(256).optional(),
	clientTurnId: z.string().min(1).max(256).optional(),
});

export type ClientMessageIdentity = Readonly<z.infer<typeof clientMessageIdentitySchema>>;

export type PreparedClientInput = ClientMessageIdentity & {
	readonly text: string;
	readonly images?: ImageContent[];
	readonly mode: "steer" | "followUp";
	readonly enqueueOrder: number;
};

/** Copy only correlation metadata, never the rest of a prompt's options. */
export function clientMessageIdentity(value: ClientMessageIdentity = {}): ClientMessageIdentity {
	return {
		...(value.clientMessageId === undefined ? {} : { clientMessageId: value.clientMessageId }),
		...(value.clientTurnId === undefined ? {} : { clientTurnId: value.clientTurnId }),
	};
}

export function readClientMessageIdentity(value: unknown): ClientMessageIdentity {
	const parsed = clientMessageIdentitySchema.safeParse(value);
	return parsed.success ? clientMessageIdentity(parsed.data) : {};
}
