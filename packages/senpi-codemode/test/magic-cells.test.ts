import { describe, expect, it } from "vitest";
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
});
