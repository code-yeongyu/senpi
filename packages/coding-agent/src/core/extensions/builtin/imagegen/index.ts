import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { resolveImageGenAuth } from "./auth.ts";
import { imageGenRegistryOverride } from "./state.ts";
import { generateImageTool } from "./tool.ts";

const IMAGEGEN_BASE_DIR = dirname(fileURLToPath(import.meta.url));
// Bun compile extracts imported file assets to a real path; Node dist keeps using the copied skill.
const embeddedSkillPath = process.versions.bun
	? import("./skill/SKILL.md", { with: { type: "file" } }).then((module) => module.default as string)
	: Promise.resolve(undefined);
let loggedMissingSkill = false;

export const IMAGE_GEN_SECTION = `
## Image Generation

When image generation tooling is present, read the gpt-image-gen skill before generating.
Use the image generation tool currently available in this session.
`;

async function isImageGenActive(ctx: ExtensionContext): Promise<boolean> {
	const auth = await resolveImageGenAuth({ modelRegistry: imageGenRegistryOverride() ?? ctx.modelRegistry });
	return auth.kind !== "none";
}

async function bundledSkillPath(baseDir: string): Promise<string | undefined> {
	const skillPath = join(baseDir, "skill", "SKILL.md");
	if (existsSync(skillPath)) return skillPath;
	const embeddedPath = await embeddedSkillPath;
	if (baseDir === IMAGEGEN_BASE_DIR && embeddedPath !== undefined && existsSync(embeddedPath)) return embeddedPath;
	if (!loggedMissingSkill) {
		loggedMissingSkill = true;
		console.error(`[imagegen] bundled skill not found at ${skillPath}; skipping contribution`);
	}
	return undefined;
}

export function registerImageGenExtension(pi: ExtensionAPI, baseDir = IMAGEGEN_BASE_DIR): void {
	pi.registerTool(generateImageTool);

	pi.on("resources_discover", async (_event, ctx) => {
		if (!(await isImageGenActive(ctx))) return undefined;
		const skillPath = await bundledSkillPath(baseDir);
		return skillPath === undefined ? undefined : { skillPaths: [skillPath] };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!(await isImageGenActive(ctx))) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${IMAGE_GEN_SECTION}` };
	});
}

export default function imageGenExtension(pi: ExtensionAPI): void {
	registerImageGenExtension(pi);
}
