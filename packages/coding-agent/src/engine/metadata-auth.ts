import { type EngineCommandMetadata, flag, input, requiredFlag } from "./metadata-flags.ts";

const TARGET_FLAGS = [flag(["--provider"], true, input("provider")), flag(["--model"], true, input("model"))];
const CHECK_FLAGS = [
	...TARGET_FLAGS,
	flag(["--no-refresh"], false, input("refresh", false)),
	flag(["--json"], false, { kind: "render" }),
];

/** `auth`: the status check, and the three provider-credential operations (security design 5.5). */
export const AUTH_COMMANDS: readonly EngineCommandMetadata[] = [
	{ call: "auth.check", argv: ["auth", "check"], positionals: [], flags: CHECK_FLAGS },
	{
		call: "auth.credentials",
		argv: ["auth", "check"],
		positionals: [],
		flags: [requiredFlag(["--credentials"], false, { kind: "selector" }), ...CHECK_FLAGS],
	},
	{ call: "auth.apiKey", argv: ["auth", "print-api-key"], positionals: [], flags: TARGET_FLAGS },
	{
		call: "auth.bearerToken",
		argv: ["auth", "print-bearer-token"],
		positionals: [],
		flags: [...TARGET_FLAGS, flag(["--min-expiry"], true, input("min_expiry_ms", undefined, "duration"))],
	},
];
