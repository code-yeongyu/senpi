import { describe, expect, it } from "vitest";
import type { BrandProfile } from "../src/core/brand.ts";
import {
	buildRuntimeNotice,
	type RuntimeNoticeGate,
	type RuntimeNoticeInput,
	reinstallTarget,
	runtimeNoticeSkipReason,
} from "../src/modes/interactive/runtime-notice.ts";

function gate(overrides: Partial<RuntimeNoticeGate>): RuntimeNoticeGate {
	return {
		versions: { node: "24.1.0" },
		env: {},
		hasInheritedInspectorOption: false,
		skipRequested: false,
		engineVersion: "2026.9.27",
		shownVersion: undefined,
		...overrides,
	};
}

describe("runtimeNoticeSkipReason", () => {
	it("shows on node when nothing opts out", () => {
		expect(runtimeNoticeSkipReason(gate({}))).toBeUndefined();
	});

	it("stays hidden on bun, including compiled binaries and bun re-execs", () => {
		expect(runtimeNoticeSkipReason(gate({ versions: { node: "24.1.0", bun: "1.4.2" } }))).toBe("bun-runtime");
	});

	it("honors SENPI_RUNTIME=node for standalone senpi", () => {
		expect(runtimeNoticeSkipReason(gate({ env: { SENPI_RUNTIME: "node" } }))).toBe("node-pinned");
	});

	it("ignores the SENPI_RUNTIME=node the OmO Native launcher forwards", () => {
		expect(runtimeNoticeSkipReason(gate({ env: { OMO_NATIVE: "1", SENPI_RUNTIME: "node" } }))).toBeUndefined();
	});

	it("honors OMO_RUNTIME=node under OmO Native", () => {
		expect(
			runtimeNoticeSkipReason(gate({ env: { OMO_NATIVE: "1", OMO_RUNTIME: "node", SENPI_RUNTIME: "node" } })),
		).toBe("node-pinned");
	});

	it("stays hidden for debugger sessions, explicit skips, and an already shown version", () => {
		expect(runtimeNoticeSkipReason(gate({ hasInheritedInspectorOption: true }))).toBe("inspector");
		expect(runtimeNoticeSkipReason(gate({ skipRequested: true }))).toBe("skip-requested");
		expect(runtimeNoticeSkipReason(gate({ shownVersion: "2026.9.27" }))).toBe("already-shown");
	});

	it("shows again after an update to a new engine version", () => {
		expect(runtimeNoticeSkipReason(gate({ shownVersion: "2026.9.26" }))).toBeUndefined();
	});
});

const omoUpdate = { packageName: "omo-ai", distTag: "beta", command: "npm i -g omo-ai@beta" };

const omoBrand: BrandProfile = {
	name: "OmO",
	command: "omo",
	configDir: ".omo",
	flatLayout: true,
	envPrefix: "OMO",
	userAgent: "omo",
	update: omoUpdate,
};

function input(overrides: Partial<RuntimeNoticeInput>): RuntimeNoticeInput {
	return {
		appName: "senpi",
		appCommand: "senpi",
		nodeVersion: "v24.1.0",
		platform: "linux",
		installMethod: "npm",
		target: reinstallTarget(undefined, "@code-yeongyu/senpi"),
		bun: { kind: "missing" },
		pinEnvName: "SENPI_RUNTIME",
		...overrides,
	};
}

function lines(spec: ReturnType<typeof buildRuntimeNotice>): string[] {
	return (spec.extra ?? []).map((line) => line.text);
}

describe("buildRuntimeNotice", () => {
	it("tells an npm senpi user without bun to install bun, then clean-reinstall", () => {
		const spec = buildRuntimeNotice(input({}));
		expect(spec.title).toBe("Running on Node.js");
		expect(spec.tone).toBe("warning");
		expect(spec.why).toContain("senpi is running on Node.js v24.1.0");
		expect(lines(spec)).toEqual([
			"Install Bun: curl -fsSL https://bun.sh/install | bash",
			"Then reinstall with Bun: npm uninstall -g @code-yeongyu/senpi && bun add -g --ignore-scripts @code-yeongyu/senpi",
			"To stay on Node.js and hide this notice, set SENPI_RUNTIME=node.",
		]);
	});

	it("uses the OmO Native package, channel, and pin variable under the omo brand", () => {
		const spec = buildRuntimeNotice(
			input({
				appName: "OmO",
				appCommand: "omo",
				target: reinstallTarget(omoBrand, "@code-yeongyu/senpi"),
				bun: { kind: "outdated", version: "1.3.9" },
				pinEnvName: "OMO_RUNTIME",
			}),
		);
		expect(spec.why).toContain("OmO is running on Node.js");
		expect(lines(spec)).toEqual([
			"Upgrade Bun (found 1.3.9, needs 1.4.0+): bun upgrade",
			"Then reinstall with Bun: npm uninstall -g omo-ai && bun add -g omo-ai@beta",
			"To stay on Node.js and hide this notice, set OMO_RUNTIME=node.",
		]);
	});

	it("asks for a restart instead of a reinstall when bun already installed the package", () => {
		expect(
			lines(buildRuntimeNotice(input({ installMethod: "bun", bun: { kind: "outdated", version: "1.2.0" } })))[1],
		).toBe("Then restart senpi.");
	});

	it("offers only the reinstall when a current bun is already present", () => {
		expect(
			lines(buildRuntimeNotice(input({ installMethod: "pnpm", bun: { kind: "ready", version: "1.4.2" } }))),
		).toEqual([
			"Reinstall with Bun: pnpm remove -g @code-yeongyu/senpi && bun add -g --ignore-scripts @code-yeongyu/senpi",
			"To stay on Node.js and hide this notice, set SENPI_RUNTIME=node.",
		]);
	});

	it("uses the Windows bun installer and yarn's global remove", () => {
		const spec = buildRuntimeNotice(input({ platform: "win32", installMethod: "yarn" }));
		expect(lines(spec).slice(0, 2)).toEqual([
			`Install Bun: powershell -c "irm bun.sh/install.ps1 | iex"`,
			"Then reinstall with Bun: yarn global remove @code-yeongyu/senpi && bun add -g --ignore-scripts @code-yeongyu/senpi",
		]);
	});

	it("skips the uninstall step when the installing manager is unknown", () => {
		expect(lines(buildRuntimeNotice(input({ installMethod: "unknown" })))[1]).toBe(
			"Then reinstall with Bun: bun add -g --ignore-scripts @code-yeongyu/senpi",
		);
	});

	it("offers no reinstall command for a brand without an update channel", () => {
		const { update: _update, ...selfManaged } = omoBrand;
		expect(reinstallTarget(selfManaged, "@code-yeongyu/senpi")).toBeUndefined();
		expect(lines(buildRuntimeNotice(input({ appCommand: "omo", target: undefined })))[1]).toBe("Then restart omo.");
	});

	it("drops the dist-tag for a brand on the latest channel", () => {
		expect(
			reinstallTarget({ ...omoBrand, update: { ...omoUpdate, distTag: "latest" } }, "@code-yeongyu/senpi")
				?.installSpec,
		).toBe("omo-ai");
	});
});
