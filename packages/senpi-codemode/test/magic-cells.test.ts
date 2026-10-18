import { describe, expect, it } from "vitest";
import { parsePipRequirements, splitShellWords } from "../src/environments/py-installer.ts";
import { MagicCellError, parseMagicCell } from "../src/tool/magic-cells.ts";

describe("magic cell detection", () => {
	it("Given a Python cell that is only a %pip line, then it is a host pip install with its arguments", () => {
		expect(parseMagicCell("py", "  %pip install --no-index ./x.whl  \n\n")).toEqual({
			kind: "pip",
			args: "install --no-index ./x.whl",
		});
	});

	it("Given a Python cell that is only %environment project, then it switches the environment mode", () => {
		expect(parseMagicCell("py", "%environment project")).toEqual({ kind: "environment", mode: "project" });
		expect(parseMagicCell("py", "%environment managed")).toEqual({ kind: "environment", mode: "managed" });
	});

	it("Given a cell that mixes %pip with code, then it is refused with the own-cell teaching error", () => {
		expect(() => parseMagicCell("py", "%pip install six\nimport six")).toThrow(MagicCellError);
		expect(() => parseMagicCell("py", "%pip install six\nimport six")).toThrow("put %pip on its own cell");
	});

	it("Given %environment with an unknown or missing mode, then it is refused naming the two modes", () => {
		expect(() => parseMagicCell("py", "%environment global")).toThrow("managed or project");
		expect(() => parseMagicCell("py", "%environment")).toThrow("managed or project");
	});

	it("Given ordinary code, other line magics or another language, then the cell is not a host magic", () => {
		expect(parseMagicCell("py", "import os\nprint(os.getcwd())")).toBeUndefined();
		expect(parseMagicCell("py", "%cd /tmp")).toBeUndefined();
		expect(parseMagicCell("py", "%%bash\necho hi")).toBeUndefined();
		expect(parseMagicCell("py", "%pipx install black")).toBeUndefined();
		expect(parseMagicCell("js", "%pip install six")).toBeUndefined();
	});

	it("Given leading comment lines or a backslash-continued %pip, then it is still the host magic with the joined arguments", () => {
		expect(parseMagicCell("py", "# deps for the notebook\n%pip install six")).toEqual({
			kind: "pip",
			args: "install six",
		});
		expect(parseMagicCell("py", "%pip install six \\\n    requests")).toEqual({
			kind: "pip",
			args: "install six requests",
		});
	});

	it("Given a comment line ending in a backslash, then the comment does not swallow the %pip line after it", () => {
		expect(parseMagicCell("py", "# setup \\\n%pip install six")).toEqual({ kind: "pip", args: "install six" });
	});

	it("Given a %pip line that is not the cell's first code line, such as inside a string, then the cell runs as ordinary Python", () => {
		expect(parseMagicCell("py", 'notes = """\n%pip install six\n"""\nprint(notes)')).toBeUndefined();
		expect(parseMagicCell("py", "x = 5 %pip")).toBeUndefined();
	});
});

describe("%pip argument parsing", () => {
	it("Given quoted requirements, then each quoted string is one requirement with its quotes removed", () => {
		expect(parsePipRequirements("install \"pkg[extra]>=1.0\" 'other pkg'")).toEqual(["pkg[extra]>=1.0", "other pkg"]);
	});

	it("Given a trailing comment, then the comment is not passed to pip", () => {
		expect(parsePipRequirements("install six  # pinned by the lab")).toEqual(["six"]);
		expect(splitShellWords("install six#not-a-comment")).toEqual(["install", "six#not-a-comment"]);
	});

	it("Given a Windows path, then its backslashes reach pip unchanged; in POSIX mode a backslash escapes", () => {
		expect(splitShellWords(String.raw`install C:\Users\me\wheels\pkg.whl`, false)).toEqual([
			"install",
			String.raw`C:\Users\me\wheels\pkg.whl`,
		]);
		expect(splitShellWords(String.raw`install my\ pkg`, true)).toEqual(["install", "my pkg"]);
	});

	it("Given a backslash inside double quotes in POSIX mode, then it stays unless it escapes a quote, backslash, dollar or backtick", () => {
		expect(splitShellWords(String.raw`install "a\b" "say \"hi\"" "c\\d"`, true)).toEqual([
			"install",
			String.raw`a\b`,
			'say "hi"',
			String.raw`c\d`,
		]);
	});

	it("Given a backslash-newline in POSIX mode, then it continues the word inside or outside double quotes", () => {
		expect(splitShellWords('install "a\\\nb" c\\\nd', true)).toEqual(["install", "ab", "cd"]);
	});

	it("Given an unclosed quote, then the install is refused naming the quote instead of guessing", () => {
		expect(() => parsePipRequirements('install "six')).toThrow('unclosed " quote');
	});
});
