import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getImagegenSkillDir, isBunVirtualPath } from "../../../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { imageGenAvailability } from "./auth.ts";
import { imagegenSkillPath } from "./skill-path.ts";
import { imageGenRegistryOverride } from "./state.ts";
import { generateImageTool } from "./tool.ts";

const IMAGEGEN_BASE_DIR = dirname(fileURLToPath(import.meta.url));
let loggedMissingSkill = false;

async function isImageGenActive(ctx: ExtensionContext): Promise<boolean> {
	const availability = await imageGenAvailability({ modelRegistry: imageGenRegistryOverride() ?? ctx.modelRegistry });
	return availability.kind !== "none";
}

/**
 * The compiled binary and the release bundle both rewrite this import into the absolute path of the
 * shipped asset, and the bundle runs on Node as well as Bun. Unbundled Node rejects the attribute,
 * but there the copied skill beside this module already answered. A compiled binary resolves it to a
 * Bun locator inside its virtual filesystem, which is not a real file (senpi#3799).
 */
async function embeddedSkillPath(): Promise<string | undefined> {
	try {
		const module = await import("./skill/SKILL.md", { with: { type: "file" } });
		return module.default as string;
	} catch {
		return undefined;
	}
}

/** Compiled-binary layout facts; injectable so resolution is testable from source runs. */
export interface ImagegenSkillEnvironment {
	/** Directory holding the shipped skill (`SKILL.md` inside); defaults to the ShippedAsset layout. */
	readonly shippedSkillDir?: string;
}

/**
 * Absolute path of the bundled imagegen skill, or undefined (logged once) when it is not shipped.
 *
 * A compiled Bun binary has no readable module-relative asset: the embedded import resolves to a
 * Bun locator (`/$bunfs/…`, `~BUN…`) that exists only inside the process, so descriptor-based
 * readers and every client fail on it (senpi#3799). Resolution therefore prefers real files only:
 * the module-relative copy, then the skill directory shipped beside the executable — exactly as
 * themes, interactive assets and the codemode sidecar resolve — and a Bun locator is never returned.
 * The miss is reported on stderr because stdout may carry the RPC protocol stream.
 */
export async function bundledSkillPath(
	baseDir: string,
	environment: ImagegenSkillEnvironment = {},
): Promise<string | undefined> {
	const skillPath = imagegenSkillPath(baseDir);
	if (existsSync(skillPath) && !isBunVirtualPath(skillPath)) return skillPath;
	const shippedSkill = join(environment.shippedSkillDir ?? getImagegenSkillDir(), "SKILL.md");
	if (existsSync(shippedSkill)) return shippedSkill;
	if (baseDir === IMAGEGEN_BASE_DIR) {
		const embeddedPath = await embeddedSkillPath();
		if (embeddedPath !== undefined && existsSync(embeddedPath) && !isBunVirtualPath(embeddedPath)) {
			return embeddedPath;
		}
	}
	if (!loggedMissingSkill) {
		loggedMissingSkill = true;
		console.error(`[imagegen] bundled skill not found at ${skillPath} or ${shippedSkill}; skipping contribution`);
	}
	return undefined;
}

export function registerImageGenExtension(
	pi: ExtensionAPI,
	baseDir: string = IMAGEGEN_BASE_DIR,
	environment: ImagegenSkillEnvironment = {},
): void {
	pi.registerTool(generateImageTool);

	pi.on("resources_discover", async (_event, ctx) => {
		if (!(await isImageGenActive(ctx))) return undefined;
		const skillPath = await bundledSkillPath(baseDir, environment);
		return skillPath === undefined ? undefined : { skillPaths: [skillPath] };
	});
}

export default function imageGenExtension(pi: ExtensionAPI): void {
	registerImageGenExtension(pi);
}
