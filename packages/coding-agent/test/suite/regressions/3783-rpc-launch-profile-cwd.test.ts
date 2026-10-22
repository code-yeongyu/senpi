import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineBuildIdentityFrom } from "../../../src/core/engine-build-identity.ts";
import {
	decideHostAction,
	GENERATION_HANDOFF_CAPABILITY,
	HOST_PROTOCOL_VERSION,
	REQUIRED_HOST_CAPABILITIES,
} from "../../../src/modes/rpc/host-decision.ts";
import { anchorSupervisorCwd, resolveHostChildLaunch } from "../../../src/modes/rpc/host-lifecycle-launch.ts";
import {
	absoluteHostArgs,
	hostLaunchProfile,
	socketHostLaunchProfile,
} from "../../../src/modes/rpc/protocol-identity.ts";
import type { RpcLaunchProfile } from "../../../src/modes/rpc/rpc-types.ts";

// senpi#3783 review: the caller derives the launch profile in ITS cwd, the host child in its agent dir.
describe("launch profile across the supervisor's cwd move", () => {
	const originalCwd = process.cwd();
	let root: string;
	let callerCwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "rpc3783-profile-")));
		callerCwd = join(root, "caller-worktree");
		agentDir = join(root, "agent");
		mkdirSync(callerCwd);
		process.chdir(callerCwd);
	});
	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(root, { recursive: true, force: true });
	});

	function bothSides(hostArgs: readonly string[]): {
		caller: RpcLaunchProfile;
		child: RpcLaunchProfile;
		childArgs: readonly string[];
	} {
		// What ensureHost/handoffHost do: the caller makes the args absolute, then everything downstream uses them.
		const callerArgs = absoluteHostArgs(hostArgs, process.cwd());
		const caller = socketHostLaunchProfile(callerArgs, process.cwd());
		const launch = anchorSupervisorCwd({ socket: join(root, "rpc.sock"), hostArgs: callerArgs }, agentDir);
		const childArgv = resolveHostChildLaunch(launch, join(root, "internal.sock"), true).args;
		return { caller, child: hostLaunchProfile(childArgv, process.cwd()), childArgs: launch.hostArgs };
	}

	it("gives the caller and the host child the same profile_id", () => {
		const { caller, child } = bothSides(["--extension", "./ext/later.js", "--extension", "npm:@scope/foo"]);
		expect(process.cwd()).toBe(resolve(agentDir));
		expect(child.profile_id).toBe(caller.profile_id);
		expect(child.core.extensions).toEqual(caller.core.extensions);
	});

	it("keeps an npm: spec verbatim on both sides", () => {
		const { caller, child, childArgs } = bothSides(["--extension", "npm:@scope/foo"]);
		expect(childArgs).toEqual(["--extension", "npm:@scope/foo"]);
		expect(caller.core.extensions).toEqual(["npm:@scope/foo"]);
		expect(child.core.extensions).toEqual(["npm:@scope/foo"]);
	});

	it("resolves a not-yet-existing relative path against the caller's cwd", () => {
		const { childArgs, child } = bothSides(["--extension", "./ext/later.js"]);
		expect(childArgs).toEqual(["--extension", resolve(callerCwd, "ext/later.js")]);
		expect(child.core.extensions).toEqual([resolve(callerCwd, "ext/later.js")]);
	});

	// Review round 2: a bare value is a caller-cwd path even when it does not exist yet, exactly as
	// `resolveCliPaths` reads it; it never reaches the host child relative, so the agent dir never anchors it.
	it("resolves a not-yet-existing bare --session-dir and -e under the caller on both sides", () => {
		const { caller, child, childArgs } = bothSides(["--session-dir", "sessions", "-e", "myext.ts"]);
		expect(childArgs).toEqual(["--session-dir", join(callerCwd, "sessions"), "-e", join(callerCwd, "myext.ts")]);
		expect(caller.core.extensions).toEqual([join(callerCwd, "myext.ts")]);
		expect(child.core.extensions).toEqual(caller.core.extensions);
		expect(child.profile_id).toBe(caller.profile_id);
	});

	it("still hands off to a newer build launched the same way (covers() holds)", () => {
		const { caller, child } = bothSides(["--extension", "./ext/later.js", "--extension", "npm:@scope/foo"]);
		const running = engineBuildIdentityFrom({ version: "2026.9.16" });
		const decision = decideHostAction(
			{
				protocolVersion: HOST_PROTOCOL_VERSION,
				requiredCapabilities: REQUIRED_HOST_CAPABILITIES,
				identity: engineBuildIdentityFrom({ version: "2026.9.18" }),
				launchProfile: caller,
				startedByUs: false,
				platform: "darwin",
			},
			{
				protocolVersion: HOST_PROTOCOL_VERSION,
				serverVersion: running.text,
				capabilities: [...REQUIRED_HOST_CAPABILITIES, GENERATION_HANDOFF_CAPABILITY],
				engineVersion: running.text,
				engineOrdinal: running.ordinal,
				launch_profile: child,
			},
			"upgrade",
		);
		expect(decision).toEqual({ action: "handoff", reason: "newer_engine", upgradeable: true });
	});
});
