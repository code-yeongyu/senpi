import { describe, expect, it } from "vitest";
import type { SourceInfo } from "../src/core/source-info.ts";
import {
	buildResourceScopeGroups,
	getDisplaySourceInfo,
	getResourceScopeGroup,
	getScopeAutocompleteTag,
	isSystemResource,
} from "../src/modes/interactive/loaded-resource-scopes.ts";

function info(path: string, overrides: Partial<SourceInfo>): SourceInfo {
	return { path, source: "local", scope: "project", origin: "top-level", ...overrides };
}

const builtin = info("<builtin:todowrite>", { source: "builtin", scope: "system" });
const systemPackage = info("/pkg/extensions/harness.js", { source: "cli", scope: "system", baseDir: "/pkg" });
const adHoc = info("/tmp/ad-hoc/index.ts", { source: "cli", scope: "temporary", baseDir: "/tmp/ad-hoc" });
const user = info("/agent/extensions/mine.ts", { scope: "user" });
const project = info("/project/.senpi/extensions/ours.ts", { scope: "project" });
const npmPackage = info("/project/.senpi/npm/node_modules/pi-x/extensions/index.ts", {
	source: "npm:pi-x",
	origin: "package",
	baseDir: "/project/.senpi/npm/node_modules/pi-x",
});

describe("loaded resource scopes", () => {
	it("classifies the system scope ahead of the cli and temporary fallbacks", () => {
		expect(getResourceScopeGroup(builtin)).toBe("system");
		expect(getResourceScopeGroup(systemPackage)).toBe("system");
		expect(getResourceScopeGroup(adHoc)).toBe("path");
		expect(getResourceScopeGroup(user)).toBe("user");
		expect(getResourceScopeGroup(project)).toBe("project");
		expect(getResourceScopeGroup(undefined)).toBe("project");
	});

	it("marks only system-scoped resources as system", () => {
		expect(isSystemResource(builtin)).toBe(true);
		expect(isSystemResource(systemPackage)).toBe(true);
		expect(isSystemResource(adHoc)).toBe(false);
		expect(isSystemResource(user)).toBe(false);
		expect(isSystemResource(undefined)).toBe(false);
	});

	it("orders groups project, user, path, system and keeps packages inside their group", () => {
		const groups = buildResourceScopeGroups([
			{ path: builtin.path, sourceInfo: builtin },
			{ path: adHoc.path, sourceInfo: adHoc },
			{ path: user.path, sourceInfo: user },
			{ path: project.path, sourceInfo: project },
			{ path: npmPackage.path, sourceInfo: npmPackage },
			{ path: systemPackage.path, sourceInfo: systemPackage },
		]);

		expect(groups.map((group) => group.scope)).toEqual(["project", "user", "path", "system"]);
		expect(groups[0]?.paths.map((item) => item.path)).toEqual([project.path]);
		expect([...(groups[0]?.packages.keys() ?? [])]).toEqual(["npm:pi-x"]);
		expect(groups[3]?.paths.map((item) => item.path)).toEqual([builtin.path, systemPackage.path]);
		expect(groups[3]?.packages.size).toBe(0);
	});

	it("abbreviates every scope for autocomplete tags, system included", () => {
		expect(getScopeAutocompleteTag("user")).toBe("u");
		expect(getScopeAutocompleteTag("project")).toBe("p");
		expect(getScopeAutocompleteTag("temporary")).toBe("t");
		expect(getScopeAutocompleteTag("system")).toBe("s");
	});

	it("labels system resources as system in diagnostics", () => {
		expect(getDisplaySourceInfo(builtin)).toEqual({ label: "system", color: "muted" });
		expect(getDisplaySourceInfo(systemPackage)).toEqual({ label: "system", color: "muted" });
		expect(getDisplaySourceInfo(adHoc)).toEqual({ label: "path", scopeLabel: "temp", color: "muted" });
		expect(getDisplaySourceInfo(user)).toEqual({ label: "user", color: "muted" });
	});
});
