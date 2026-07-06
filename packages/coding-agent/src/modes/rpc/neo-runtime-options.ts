/**
 * NeoRuntimeOptions — the typed handshake payload a neo client sends so the
 * daemon builds THAT connection's runtime exactly as the classic launcher would.
 *
 * Every field here corresponds to a `parsed.<field>` read in the classic
 * runtime-construction path (main.ts). The neo launcher forwards the classic
 * argv (see cli/neo/build-argv.ts); the daemon reconstructs a runtime from this
 * payload per connection, so per-client startup flags survive daemon sharing.
 *
 * The mapping between classic parsed fields and this payload is captured by
 * {@link NEO_RUNTIME_OPTION_SOURCE_FIELDS} and enforced by an extraction test
 * (neo-runtime-options-extraction.test.ts): the test statically scans the
 * runtime-construction path for `parsed.*` reads and fails if any runtime field
 * is not represented here. It is therefore GENERATED FROM the source, never
 * hand-maintained — a future consumer of a new parsed field fails the test until
 * it is threaded through this payload.
 *
 * Documented carve-outs (fields the daemon deliberately does NOT accept because
 * they are launcher fast-paths or resolve before the daemon is ever reached):
 * see {@link NEO_RUNTIME_OPTION_CARVEOUT_FIELDS}.
 */

/**
 * The typed per-connection runtime options.
 *
 * Values mirror the classic `Args` shape for the runtime-relevant subset. All
 * fields are optional: an omitted field means "classic default" for that flag.
 * Initial inputs (`messages`, `fileArgs`) are forwarded RAW and expanded by the
 * daemon-side handler with the client's cwd (image auto-resize included).
 */
export interface NeoRuntimeOptions {
	// Provider / model / thinking / auth.
	readonly provider?: string;
	readonly model?: string;
	readonly models?: readonly string[];
	readonly thinking?: string;
	/**
	 * Per-connection API key. Applied ONLY to this connection's own AuthStorage
	 * so one client's --api-key can never leak into another connection.
	 */
	readonly apiKey?: string;

	// Session selection.
	readonly noSession?: boolean;
	readonly session?: string;
	readonly sessionId?: string;
	readonly sessionDir?: string;
	readonly fork?: string;
	readonly name?: string;
	readonly resume?: boolean;
	readonly continue?: boolean;

	// Approval / project trust.
	readonly projectTrustOverride?: boolean;

	// Tool scoping.
	readonly tools?: readonly string[];
	readonly excludeTools?: readonly string[];
	readonly noTools?: boolean;
	readonly noBuiltinTools?: boolean;

	// Resource loading.
	readonly extensions?: readonly string[];
	readonly skills?: readonly string[];
	readonly promptTemplates?: readonly string[];
	readonly themes?: readonly string[];
	readonly noExtensions?: boolean;
	readonly noSkills?: boolean;
	readonly noPromptTemplates?: boolean;
	readonly noThemes?: boolean;
	readonly noContextFiles?: boolean;

	/** Unknown flags (extension flags): name -> value. */
	readonly unknownFlags?: Readonly<Record<string, boolean | string>>;

	// Initial inputs — forwarded RAW; daemon expands @file/image paths per cwd.
	readonly messages?: readonly string[];
	readonly fileArgs?: readonly string[];
}

/**
 * Every classic `parsed.<field>` the runtime-construction path reads that MUST
 * be represented in {@link NeoRuntimeOptions}. This is the contract the
 * extraction test enforces against the actual source.
 *
 * Keep this in `parsed`-field spelling (the classic Args key), because that is
 * what the extraction test scans for in main.ts.
 */
export const NEO_RUNTIME_OPTION_SOURCE_FIELDS = [
	"provider",
	"model",
	"models",
	"thinking",
	"apiKey",
	"noSession",
	"session",
	"sessionId",
	"sessionDir",
	"fork",
	"name",
	"resume",
	"continue",
	"projectTrustOverride",
	"tools",
	"excludeTools",
	"noTools",
	"noBuiltinTools",
	"extensions",
	"skills",
	"promptTemplates",
	"themes",
	"noExtensions",
	"noSkills",
	"noPromptTemplates",
	"noThemes",
	"noContextFiles",
	"unknownFlags",
	"messages",
	"fileArgs",
] as const satisfies readonly (keyof import("../../cli/args.ts").Args)[];

/**
 * Classic `parsed.*` fields the runtime path reads that the daemon deliberately
 * does NOT accept in the handshake, each with the reason it resolves before the
 * daemon or is intentionally launcher-local. The extraction test allows these.
 */
export const NEO_RUNTIME_OPTION_CARVEOUT_FIELDS: Readonly<Record<string, string>> = {
	// Launcher fast-paths: handled and exited before any runtime is constructed.
	help: "classic --help fast-path; never reaches the daemon",
	version: "classic --version fast-path; never reaches the daemon",
	export: "classic --export fast-path; never reaches the daemon",
	listModels: "classic --list-models fast-path; never reaches the daemon",
	// Mode / dispatch: the daemon path is chosen by the launcher, not forwarded.
	mode: "output mode dispatch; the daemon always speaks rpc over the socket",
	print: "print-mode dispatch; TTY-less --neo falls back to classic print in the launcher",
	neo: "the --neo flag itself; consumed by the launcher to choose the neo path",
	// Diagnostics are produced by the parser, not a runtime input.
	diagnostics: "parser-produced diagnostics; not a runtime construction input",
	// Neo launcher-local flags never forwarded to the daemon runtime.
	neoIsolated: "launcher-local: selects isolated transport, not a runtime input",
	neoBin: "launcher-local: dev binary override, not a runtime input",
	// Neo daemon supervisor flags: consumed by the daemon launcher, never a
	// per-connection runtime input (each connection's runtime comes from the
	// handshake NeoRuntimeOptions, not the daemon's own argv).
	neoListen: "daemon-supervisor: socket path to bind; not a per-connection runtime input",
	neoRegister: "daemon-supervisor: self-register flag; not a per-connection runtime input",
	// Verbose controls classic startup logging / InteractiveMode; neo renders its
	// own UI and does not consume classic verbose startup output.
	verbose: "classic InteractiveMode/startup verbosity; neo renders its own UI",
} as const;
