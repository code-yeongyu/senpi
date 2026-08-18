import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { resolveImageGenAuth } from "./auth.ts";
import { imageGenRegistryOverride } from "./state.ts";
import { generateImageTool } from "./tool.ts";

const IMAGEGEN_BASE_DIR = dirname(fileURLToPath(import.meta.url));
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

function bundledSkillPath(baseDir: string): string | undefined {
	const skillPath = join(baseDir, "skill", "SKILL.md");
	if (existsSync(skillPath)) return skillPath;
	if (!loggedMissingSkill) {
		loggedMissingSkill = true;
		console.debug(`[imagegen] bundled skill not found at ${skillPath}; skipping contribution`);
	}
	return undefined;
}

export function registerImageGenExtension(pi: ExtensionAPI, baseDir = IMAGEGEN_BASE_DIR): void {
	pi.registerTool(generateImageTool);

	pi.on("resources_discover", async (_event, ctx) => {
		if (!(await isImageGenActive(ctx))) return undefined;
		const skillPath = bundledSkillPath(baseDir);
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
