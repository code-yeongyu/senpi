import * as Diff from "diff";

export function createUnifiedPatch(
	oldPath: string,
	newPath: string,
	oldContent: string,
	newContent: string,
	contextLines = 4,
): string {
	return Diff.createTwoFilesPatch(oldPath, newPath, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}
