import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/2651

beforeAll(() => initTheme("dark"));

function renderAll(container: Container, width = 120): string {
	return container.render(width).flat().join("\n");
}

function fakeResourcesThis(skills: Array<{ filePath: string; name: string }>, expanded: boolean) {
	const fakeThis: any = {
		options: { verbose: false },
		toolOutputExpanded: expanded,
		loadedResourcesContainer: new Container(),
		chatContainer: new Container(),
		settingsManager: {
			getQuietStartup: () => false,
			getDisabledBuiltinExtensions: () => [],
		},
		sessionManager: { getCwd: () => "/tmp/project" },
		session: {
			promptTemplates: [],
			extensionRunner: { getCommandDiagnostics: () => [], getShortcutDiagnostics: () => [] },
			resourceLoader: {
				getPathMetadata: () => new Map(),
				getAgentsFiles: () => ({ agentsFiles: [] }),
				getSystemPromptSource: () => undefined,
				getAppendSystemPromptSources: () => [],
				getSkills: () => ({ skills, diagnostics: [] }),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
			},
		},
		formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
		formatExtensionDisplayPath: (p: string) =>
			(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
		formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
		getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
		getBuiltinExtensionNameFromPath: (InteractiveMode as any).prototype.getBuiltinExtensionNameFromPath,
		getBuiltinExtensionDisplayName: (InteractiveMode as any).prototype.getBuiltinExtensionDisplayName,
		formatExtensionScopeGroups: (extensions: unknown[]) =>
			(InteractiveMode as any).prototype.formatExtensionScopeGroups.call(fakeThis, extensions),
		buildScopeGroups: (items: Array<{ path: string; sourceInfo?: unknown }>) =>
			(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items),
		formatScopeGroups: (groups: unknown, formatOptions: unknown) =>
			(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions),
		isPackageSource: (sourceInfo?: unknown) =>
			(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
		getShortPath: (p: string, sourceInfo?: unknown) =>
			(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
		getCompactPathLabel: (p: string, sourceInfo?: unknown) =>
			(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
		getCompactPackageSourceLabel: (sourceInfo?: unknown) =>
			(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
		getCompactExtensionLabel: (p: string, sourceInfo?: unknown) =>
			(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
		getCompactDisplayPathSegments: (p: string) =>
			(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
		getCompactNonPackageExtensionLabel: (p: string, i: number, all: unknown) =>
			(InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, i, all),
		formatDiagnostics: () => [],
		getBuiltInCommandConflictDiagnostics: () => [],
	};
	return fakeThis;
}

const MANY_SKILLS = Array.from({ length: 69 }, (_, i) => ({
	filePath: `/tmp/skills/skill-${String(i).padStart(2, "0")}/SKILL.md`,
	name: `skill-${String(i).padStart(2, "0")}`,
}));

describe("startup banner fold", () => {
	test("the compact list truncates to a few names with a +N more hint, so the first screen fits", () => {
		const fakeThis = fakeResourcesThis(MANY_SKILLS, false);
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: true });
		const out = renderAll(fakeThis.loadedResourcesContainer);

		expect(out).toContain("[Skills]");
		expect(out).toMatch(/\+\d+ more/);
		// Not all 69 names are inlined in the collapsed body.
		expect(out).not.toContain("skill-40");
		expect(out).not.toContain("skill-68");
	});

	test("expanding reveals the full list", () => {
		const fakeThis = fakeResourcesThis(MANY_SKILLS, true);
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: true });
		const out = renderAll(fakeThis.loadedResourcesContainer);
		expect(out).toContain("skill-68");
	});

	test("the collapsed body keeps some real names, not just a bare count", () => {
		const fakeThis = fakeResourcesThis(MANY_SKILLS, false);
		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, { force: true });
		const out = renderAll(fakeThis.loadedResourcesContainer);
		// At least one actual skill name is still shown (the fold is a truncation, not a count).
		expect(out).toMatch(/skill-0[0-9]/);
	});
});
