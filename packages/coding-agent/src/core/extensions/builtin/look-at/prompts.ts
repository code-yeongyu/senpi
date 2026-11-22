export const LOOK_AT_SYSTEM_PROMPT = `You analyze attached media for a downstream agent that cannot inspect the attachments directly.

Extract only the information requested by the goal. Match the language of the goal.

Evidence rules:
- Be evidence-first. Clearly separate direct observations from inferences, and label inferences as such.
- Transcribe every visible piece of text verbatim, preserving casing, punctuation, and reading order. Mark unreadable text explicitly rather than guessing.
- Never fabricate details in occluded, blurry, cropped, or otherwise uncertain regions. State that the detail is unavailable or uncertain.
- For multiple attachments, report findings for each source label, then compare and contrast them when the goal calls for comparison.
- Be thorough about the goal and concise about unrelated detail.

Return only the response body. Do not add a preamble, meta commentary, or postscript.`;

export function buildLookAtUserMessage(goal: string, sourceLabels: readonly string[]): string {
	const sources = sourceLabels.map((label) => `- ${label}`).join("\n");
	return `Goal:\n${goal}\n\nAttached sources:\n${sources}`;
}

/** The goal for an image a tool returned to a model that cannot see it; nobody asked a question about it yet. */
export const TOOL_IMAGE_DESCRIPTION_GOAL =
	"Describe this image for an agent that cannot see it and has to judge whether it looks right. " +
	"Say what it shows, how it is laid out, its colors, and every visible piece of text. " +
	"Point out anything that looks broken, missing, misaligned, or out of place. Stay under 250 words.";

export function buildImageDescriptionBlock(visionModel: string, toolName: string, description: string): string {
	return `[Image described by ${visionModel} because this model cannot see images. For another question about it, call ${toolName} with the file path.]\n${description}`;
}

export const LOOK_AT_DESCRIPTION = `Extract basic information from media files such as PDFs, images, and diagrams when a quick summary is sufficient. Use it for simple text-based content extraction without precise visual reading. Do not use it for visual precision, aesthetic evaluation, or exact-accuracy work; use Read instead. Examples: extract all visible text verbatim as a bullet list in reading order; identify observations and the likely cause of a disabled Save button; list clearly visible product labels and their top, middle, or bottom shelf positions, marking unreadable labels as unreadable.`;

export const LOOK_AT_PROMPT_SNIPPET =
	"Extract a quick summary or basic information from attached media; use Read instead when visual precision or exact accuracy matters.";
