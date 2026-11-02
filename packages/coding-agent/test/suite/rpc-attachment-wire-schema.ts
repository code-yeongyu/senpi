import { z } from "zod";

// Independent transcription of wire contract v1.1 (lead ruling 2026-10-22, senpi#3795), not inferred from the
// host's TypeScript types.
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const auth = z.strictObject({
	launch_id: z.string().uuid(),
	server_nonce: hex32,
	server_proof: hex32,
});
const envelope = z.object({
	id: z.string().optional(),
	type: z.literal("response"),
	sessionId: z.string().optional(),
});
const success = <T extends z.ZodType>(command: string, data: T) =>
	envelope.extend({ command: z.literal(command), success: z.literal(true), data });
const refusal = (command: string, codes: readonly string[]) =>
	envelope.extend({
		command: z.literal(command),
		success: z.literal(false),
		error: z.string(),
		errorCode: z.enum(codes),
		errorData: z.record(z.string(), z.unknown()).optional(),
	});

// Host draining is not a code of its own: session_busy_lifecycle carries reason "host_draining".
const draining = z.strictObject({ reason: z.literal("host_draining") });
// The attachment commands' own session_not_attached carries errorData { reason } only, never the gate's action.
const notAttached = (reason: "no_connection" | "not_attached") => z.strictObject({ reason: z.literal(reason) });

export const attachmentWireResponse = z.union([
	success("attach_session", z.strictObject({ sessionId: z.string(), attached: z.literal(true) })),
	refusal("attach_session", ["unknown_session", "session_identity_mismatch"]),
	refusal("attach_session", ["session_not_attached"]).extend({ errorData: notAttached("no_connection") }),
	refusal("attach_session", ["session_busy_lifecycle"]).extend({ errorData: draining }),
	success("release_attachment", z.strictObject({ deferred: z.boolean() })),
	refusal("release_attachment", ["session_not_attached"]).extend({ errorData: notAttached("not_attached") }),
	success("reclaim_session", z.strictObject({ reclaimed: z.literal(true), sessionId: z.string() })),
	refusal("reclaim_session", ["unknown_session", "session_identity_mismatch"]),
	refusal("reclaim_session", ["session_not_attached"]).extend({ errorData: notAttached("no_connection") }),
	refusal("reclaim_session", ["session_busy_lifecycle"]).extend({
		errorData: z.union([draining, z.strictObject({})]).optional(),
	}),
	refusal("reclaim_session", ["attached_elsewhere"]).extend({
		errorData: z.object({ attachments: z.number().int().positive() }).passthrough(),
	}),
	// release_session predates v1; v1 adds caller-aware admission, not a new success envelope.
	success(
		"release_session",
		z.strictObject({
			released: z.literal(true),
			session_path: z.string(),
			attachments: z.number().int().nonnegative(),
			dropped: z.unknown(),
		}),
	),
	refusal("release_session", [
		"attached",
		"turn_active",
		"unknown_session",
		"session_closing",
		"host_draining",
		"invalid_release_reason",
		"release_unsupported",
		"session_not_attached",
	]),
	success(
		"get_protocol_info",
		z
			.object({
				capabilities: z
					.array(z.string())
					.refine((names) =>
						["attach_session", "release_attachment", "release_caller_aware", "reclaim_session"].every((name) =>
							names.includes(name),
						),
					),
				auth: auth.optional(),
			})
			.passthrough()
			.refine((data) => data.capabilities.includes("socket_auth") === (data.auth !== undefined)),
	),
	envelope.extend({ command: z.literal("authenticate"), success: z.literal(true) }),
	envelope.extend({
		command: z.literal("authenticate"),
		success: z.literal(false),
		error: z.literal("auth_failed"),
		errorCode: z.literal("auth_failed"),
	}),
	envelope.extend({
		command: z.string(),
		success: z.literal(false),
		error: z.literal("auth_required"),
		errorCode: z.literal("auth_required"),
	}),
]);
