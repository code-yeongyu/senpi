/**
 * The host-action truth table: what a client does when it finds a host on the shared socket.
 *
 * Every row here is a decision a daemon client makes about a process it may NOT own. The two
 * rules the table exists to protect are invariants of the whole daemon design:
 *   I1 - never replace a host you did not start; the only sanctioned replacement is a drain handoff.
 *   I2 - compatibility is protocol version + capabilities, NEVER a version-string comparison, and an
 *        uncomparable ordinal never wins an upgrade.
 * The fixtures therefore give the host a DIFFERENT `serverVersion` from the client in nearly every
 * row: a decision that starts comparing version strings again turns most of this file red.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type EngineBuildIdentity, engineBuildIdentityFrom } from "../../src/core/engine-build-identity.ts";
import {
	decideHostAction,
	GENERATION_HANDOFF_CAPABILITY,
	HOST_PROTOCOL_VERSION,
	type HostDecision,
	type HostDecisionClient,
	type HostDecisionPolicy,
	type HostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "../../src/modes/rpc/host-decision.ts";
import type { RpcLaunchProfile } from "../../src/modes/rpc/rpc-types.ts";

const OMO_PLUGIN = "/opt/omo/plugin";
const MEMBER_BUNDLE = "/opt/omo/members";
const EPOCH = 1_758_000_000;
const PLUGIN_SET_A = ["/opt/omo-a/plugin", "/opt/omo-a/plugin/extensions/memory.js"];
const PLUGIN_SET_B = ["/srv/runtime-b/plugin", "/srv/runtime-b/plugin/extensions/memory.js"];
const PLUGIN_SET_WINDOWS = ["C:\\omo\\plugin", "C:\\omo\\plugin\\extensions\\memory.js"];

function identity(version: string, epoch?: number): EngineBuildIdentity {
	return engineBuildIdentityFrom(epoch === undefined ? { version } : { version, epoch, sha7: "abc1234" });
}

function profile(extensions: readonly string[]): RpcLaunchProfile {
	const core = { extensions: [...extensions].sort(), multi_session: true, session_runtime: "in-process" } as const;
	return { profile_id: createHash("sha256").update(JSON.stringify(core)).digest("hex"), core };
}

function client(overrides: Partial<HostDecisionClient> = {}): HostDecisionClient {
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		requiredCapabilities: REQUIRED_HOST_CAPABILITIES,
		identity: identity("2026.9.17"),
		launchProfile: profile([OMO_PLUGIN]),
		startedByUs: false,
		platform: "darwin",
		...overrides,
	};
}

/** A host that is compatible and handoff-capable, deliberately on an OLDER build and a DIFFERENT version string. */
function host(overrides: Partial<HostProtocolInfo> = {}): HostProtocolInfo {
	const build = identity("2026.9.16-3");
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		serverVersion: "2026.9.16-3",
		capabilities: [...REQUIRED_HOST_CAPABILITIES, GENERATION_HANDOFF_CAPABILITY],
		engineVersion: build.text,
		engineOrdinal: build.ordinal,
		launch_profile: profile([OMO_PLUGIN]),
		...overrides,
	};
}

interface Row {
	readonly name: string;
	readonly client: HostDecisionClient;
	readonly host: HostProtocolInfo | undefined;
	readonly policy: HostDecisionPolicy;
	readonly expected: HostDecision;
}

const rows: readonly Row[] = [
	{
		name: "no host on the socket -> start",
		client: client(),
		host: undefined,
		policy: "never",
		expected: { action: "start", reason: "no_host", upgradeable: false },
	},
	{
		name: "no host but the pidfile is ours -> start, naming our own dead host",
		client: client({ startedByUs: true }),
		host: undefined,
		policy: "never",
		expected: { action: "start", reason: "restart_own_host", upgradeable: false },
	},
	{
		name: "protocol version mismatch -> refuse:protocol",
		client: client(),
		host: host({ protocolVersion: 2 }),
		policy: "upgrade",
		expected: { action: "refuse", reason: "protocol", upgradeable: false },
	},
	{
		name: "missing required capability under policy never -> refuse:capability",
		client: client(),
		host: host({ capabilities: ["multi_session", "extension_events", "session_kind"] }),
		policy: "never",
		expected: { action: "refuse", reason: "capability", upgradeable: false },
	},
	{
		name: "missing required capability under policy fallback -> fallback:capability",
		client: client(),
		host: host({ capabilities: ["multi_session", "extension_events", "session_kind"] }),
		policy: "fallback",
		expected: { action: "fallback", reason: "capability", upgradeable: false },
	},
	{
		name: "missing required capability under policy upgrade -> refuse, never a second host",
		client: client(),
		host: host({ capabilities: ["multi_session", "extension_events", "session_kind"] }),
		policy: "upgrade",
		expected: { action: "refuse", reason: "capability", upgradeable: false },
	},
	{
		name: "compatible host without generation_handoff -> reuse, not upgradeable",
		client: client({ identity: identity("2026.9.18"), launchProfile: profile([OMO_PLUGIN, MEMBER_BUNDLE]) }),
		host: host({ capabilities: [...REQUIRED_HOST_CAPABILITIES] }),
		policy: "upgrade",
		expected: {
			action: "reuse",
			reason: "handoff_unsupported",
			upgradeable: false,
			warning: "profile_mismatch_attached",
		},
	},
	{
		name: "newer engine, same profile, policy upgrade -> handoff:newer_engine",
		client: client({ identity: identity("2026.9.18") }),
		host: host(),
		policy: "upgrade",
		expected: { action: "handoff", reason: "newer_engine", upgradeable: true },
	},
	{
		name: "same version, newer build, wider profile -> handoff:profile",
		client: client({
			identity: identity("2026.9.16-3", EPOCH + 60),
			launchProfile: profile([OMO_PLUGIN, MEMBER_BUNDLE]),
		}),
		host: host({ engineOrdinal: identity("2026.9.16-3", EPOCH).ordinal }),
		policy: "upgrade",
		expected: { action: "handoff", reason: "profile", upgradeable: true },
	},
	{
		name: "newer engine but a narrower extension set -> reuse, warn instead of dropping the host's extensions",
		client: client({ identity: identity("2026.9.18"), launchProfile: profile([OMO_PLUGIN]) }),
		host: host({ launch_profile: profile([OMO_PLUGIN, MEMBER_BUNDLE]) }),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_narrower_attached" },
	},
	{
		name: "a client with no launch spec never hands off -> reuse with a profile warning",
		client: client({ identity: identity("2026.9.18"), launchProfile: undefined }),
		host: host(),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_mismatch_attached" },
	},
	{
		name: "wider profile but an older engine -> reuse with a profile warning",
		client: client({ identity: identity("2026.9.15"), launchProfile: profile([OMO_PLUGIN, MEMBER_BUNDLE]) }),
		host: host(),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_mismatch_attached" },
	},
	{
		name: "equal engine and identical profile -> reuse, no warning",
		client: client({ identity: identity("2026.9.16-3") }),
		host: host(),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true },
	},
	{
		name: "same plugin set from another install root, same engine -> reuse with no profile warning",
		client: client({ identity: identity("2026.9.16-3"), launchProfile: profile(PLUGIN_SET_B) }),
		host: host({ launch_profile: profile(PLUGIN_SET_A) }),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true },
	},
	{
		name: "same plugin set from another install root, newer engine -> handoff:newer_engine, not a profile mismatch",
		client: client({ identity: identity("2026.9.18"), launchProfile: profile(PLUGIN_SET_B) }),
		host: host({ launch_profile: profile(PLUGIN_SET_A) }),
		policy: "upgrade",
		expected: { action: "handoff", reason: "newer_engine", upgradeable: true },
	},
	{
		name: "same plugin set spelled with Windows separators -> reuse with no profile warning",
		client: client({ identity: identity("2026.9.16-3"), launchProfile: profile(PLUGIN_SET_WINDOWS) }),
		host: host({ launch_profile: profile(PLUGIN_SET_A) }),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true },
	},
	{
		name: "another install root that adds a plugin extension -> a proper superset still warns and can hand off",
		client: client({
			identity: identity("2026.9.18"),
			launchProfile: profile([...PLUGIN_SET_B, "/srv/runtime-b/plugin/extensions/extra.js"]),
		}),
		host: host({ launch_profile: profile(PLUGIN_SET_A) }),
		policy: "upgrade",
		expected: { action: "handoff", reason: "newer_engine", upgradeable: true },
	},
	{
		name: "another install root that lacks a plugin extension the host loads -> narrower, never handed off",
		client: client({ identity: identity("2026.9.18"), launchProfile: profile(PLUGIN_SET_B.slice(0, 1)) }),
		host: host({ launch_profile: profile(PLUGIN_SET_A) }),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_narrower_attached" },
	},
	{
		name: "a different plugin extension under another install root is a different role -> narrower",
		client: client({
			identity: identity("2026.9.18"),
			launchProfile: profile(["/srv/runtime-b/plugin", "/srv/runtime-b/plugin/extensions/other.js"]),
		}),
		host: host({ launch_profile: profile(PLUGIN_SET_A) }),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_narrower_attached" },
	},
	{
		name: "a non-plugin extension at another path is NOT the same role -> still narrower",
		client: client({ identity: identity("2026.9.18"), launchProfile: profile([OMO_PLUGIN, "/srv/other/members"]) }),
		host: host({ launch_profile: profile([OMO_PLUGIN, MEMBER_BUNDLE]) }),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_narrower_attached" },
	},
	{
		name: "older engine, identical profile -> reuse",
		client: client({ identity: identity("2026.9.16") }),
		host: host(),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true },
	},
	{
		name: "newer engine under policy never -> reuse; the policy gates the handoff",
		client: client({ identity: identity("2026.9.18"), launchProfile: profile([OMO_PLUGIN, MEMBER_BUNDLE]) }),
		host: host(),
		policy: "never",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_mismatch_attached" },
	},
	{
		name: "policy fallback and a different engine build -> fallback:engine_mismatch",
		client: client({ identity: identity("2026.9.18") }),
		host: host(),
		policy: "fallback",
		expected: { action: "fallback", reason: "engine_mismatch", upgradeable: true },
	},
	{
		name: "policy fallback and the SAME engine build -> reuse",
		client: client({ identity: identity("2026.9.16-3") }),
		host: host(),
		policy: "fallback",
		expected: { action: "reuse", reason: "compatible", upgradeable: true },
	},
	{
		name: "win32 is attach-only: a newer client with a wider profile still reuses",
		client: client({
			identity: identity("2026.9.18"),
			launchProfile: profile([OMO_PLUGIN, MEMBER_BUNDLE]),
			platform: "win32",
		}),
		host: host(),
		policy: "upgrade",
		expected: {
			action: "reuse",
			reason: "win32_attach_only",
			upgradeable: false,
			warning: "profile_mismatch_attached",
		},
	},
	{
		name: "a host that reports no ordinal is uncomparable -> reuse",
		client: client({ identity: identity("2026.9.18") }),
		host: host({ engineOrdinal: undefined, engineVersion: undefined, launch_profile: undefined }),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_mismatch_attached" },
	},
	{
		name: "equal version where only the client's build epoch is known -> reuse, an unaged build never wins",
		client: client({ identity: identity("2026.9.16-3", EPOCH), launchProfile: profile([OMO_PLUGIN, MEMBER_BUNDLE]) }),
		host: host(),
		policy: "upgrade",
		expected: { action: "reuse", reason: "compatible", upgradeable: true, warning: "profile_mismatch_attached" },
	},
];

describe("decideHostAction", () => {
	it.each(rows)("$name", ({ client: decisionClient, host: protocol, policy, expected }) => {
		expect(decideHostAction(decisionClient, protocol, policy)).toEqual(expected);
	});

	it("requires exactly the four capabilities a daemon session needs", () => {
		expect([...REQUIRED_HOST_CAPABILITIES]).toEqual([
			"multi_session",
			"extension_events",
			"session_context",
			"session_kind",
		]);
	});
});
