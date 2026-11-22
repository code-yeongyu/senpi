import type { EvalLanguage } from "../src/tool/types.ts";
import { create, operations, setup } from "../test/workpool/cells.ts";

export type GateCell = { readonly name: string; readonly code: string };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function workpoolCell(language: EvalLanguage): GateCell {
	return { name: "workpool", code: [setup[language], create[language], operations[language]].join("\n") };
}

/** Cells are fixtures, not alternative implementations of the helpers. */
export function censusCell(language: EvalLanguage, names: readonly string[]): string {
	const json = JSON.stringify(names);
	switch (language) {
		case "js":
			return `display(${json}.filter(name => typeof globalThis[name] === "function"));`;
		case "py":
			return `display([name for name in ${json} if callable(globals().get(name)) or name == "tool" and name in globals()])`;
		case "rb":
			return `display(${json}.select { |name| respond_to?(name, true) })`;
		case "jl":
			return `display([name for name in ${json} if isdefined(Main, Symbol(name))])`;
		default:
			return assertNever(language);
	}
}

export function legacyCells(language: EvalLanguage): readonly GateCell[] {
	switch (language) {
		case "js":
			return [
				{ name: "tools-alias", code: "display(tools === tool);" },
				{ name: "display-json", code: 'display({answer: 42, nested: [null, true]});' },
				{ name: "display-markdown", code: 'display({type: "markdown", text: "**fixture**"});' },
				{ name: "display-image", code: `display({type: "image", mimeType: "image/png", data: ${JSON.stringify(png)}});` },
				{ name: "display-tool-images", code: `const images = [{mimeType: "image/png", dataBase64: ${JSON.stringify(png)}}]; display({text: "image fixture", images}); display(images[0]);` },
				{ name: "print", code: 'print("head"); print("tail");' },
				{ name: "read-write", code: 'await write("plain.txt", "plain"); display(await read("plain.txt")); await write("local://fixture.txt", "local"); display(await read("local://fixture.txt"));' },
				{ name: "traversal", code: 'await read("local://../escape");' },
				{ name: "env", code: 'env("GATE_VALUE", "value"); display(env("GATE_VALUE")); display(Object.hasOwn(env(), "GATE_VALUE"));' },
				{ name: "tool", code: 'display(await tool.fixture({value: 42}));' },
				{ name: "tool-error", code: 'await tool.failure({});' },
				{ name: "schema", code: 'display(await tool_schema("fixture"));' },
				{ name: "completion", code: 'display(await completion("fixture")); display(await completion("fixture", {schema: {type: "object"}}));' },
				{ name: "agent", code: 'display(await agent("fixture")); display(await agent("fixture", {schema: {type: "object"}})); display(await agent("fixture", {handle: true})); display(await agent("fixture-null-handle", {handle: true}));' },
				{ name: "output", code: 'display(await output("st_fixture")); display(await output("st_fixture", {format: "tail"}));' },
				{ name: "parallel", code: 'display(await parallel([async () => 2, async () => 1]));' },
				{ name: "parallel-error", code: 'await parallel([async () => { throw new Error("fixture-error"); }, async () => 1]);' },
				{ name: "pipeline", code: 'display(await pipeline([1, 2], x => x + 1, x => x * 2));' },
				{ name: "log-phase", code: 'log("fixture-log"); phase("fixture-phase");' },
			];
		case "py":
			return [
				{ name: "display-json", code: 'display({"answer": 42, "nested": [None, True]})' },
				{ name: "display-markdown", code: 'display({"type": "markdown", "text": "**fixture**"})' },
				{ name: "display-image", code: `display({"type": "image", "mimeType": "image/png", "data": ${JSON.stringify(png)}})` },
				{ name: "display-tool-images", code: `images = [{"mimeType": "image/png", "dataBase64": ${JSON.stringify(png)}}]\ndisplay({"text": "image fixture", "images": images})\ndisplay(images[0])` },
				{ name: "print", code: 'print("head")\nprint("tail")' },
				{ name: "read-write", code: 'write("plain.txt", "plain")\ndisplay(read("plain.txt"))\nwrite("local://fixture.txt", "local")\ndisplay(read("local://fixture.txt"))' },
				{ name: "traversal", code: 'read("local://../escape")' },
				{ name: "env", code: 'env("GATE_VALUE", "value")\ndisplay(env("GATE_VALUE"))\ndisplay("GATE_VALUE" in env())' },
				{ name: "tool", code: 'display(tool.fixture({"value": 42}))' },
				{ name: "tool-error", code: 'tool.failure({})' },
				{ name: "schema", code: 'display(tool_schema("fixture"))' },
				{ name: "completion", code: 'display(completion("fixture"))\ndisplay(completion("fixture", schema={"type": "object"}))' },
				{ name: "agent", code: 'display(agent("fixture"))\ndisplay(agent("fixture", schema={"type": "object"}))\ndisplay(agent("fixture", handle=True))\ndisplay(agent("fixture-null-handle", handle=True))' },
				{ name: "output", code: 'display(output("st_fixture"))\ndisplay(output("st_fixture", format="tail"))' },
				{ name: "parallel", code: 'display(parallel([lambda: 2, lambda: 1]))' },
				{ name: "parallel-error", code: 'parallel([lambda: 1 / 0, lambda: 1])' },
				{ name: "pipeline", code: 'display(pipeline([1, 2], lambda x: x + 1, lambda x: x * 2))' },
				{ name: "log-phase", code: 'log("fixture-log")\nphase("fixture-phase")' },
			];
		case "rb":
			return [
				{ name: "display-json", code: 'display({"answer" => 42, "nested" => [nil, true]})' },
				{ name: "display-markdown", code: 'display({"type" => "markdown", "text" => "**fixture**"})' },
				{ name: "display-image", code: `display_image(${JSON.stringify(png)})` },
				{ name: "display-tool-images", code: `images = [{"mimeType" => "image/png", "dataBase64" => ${JSON.stringify(png)}}]; display({"text" => "image fixture", "images" => images}); display(images[0])` },
				{ name: "print", code: 'print("head"); text("tail")' },
				{ name: "read-write", code: 'write("plain.txt", "plain"); display(read("plain.txt")); write("local://fixture.txt", "local"); display(read("local://fixture.txt"))' },
				{ name: "traversal", code: 'read("local://../escape")' },
				{ name: "env", code: 'env("GATE_VALUE", "value"); display(env("GATE_VALUE")); display(env().key?("GATE_VALUE"))' },
				{ name: "tool", code: 'display(tool.fixture({"value" => 42}))' },
				{ name: "tool-error", code: 'tool.failure({})' },
				{ name: "schema", code: 'display(tool_schema("fixture"))' },
				{ name: "completion", code: 'display(completion("fixture")); display(completion("fixture", schema: {"type" => "object"}))' },
				{ name: "agent", code: 'display(agent("fixture")); display(agent("fixture", schema: {"type" => "object"})); display(agent("fixture", handle: true)); display(agent("fixture-null-handle", handle: true))' },
				{ name: "output", code: 'display(output("st_fixture")); display(output("st_fixture", format: "tail"))' },
				{ name: "parallel", code: 'display(parallel([-> { 2 }, -> { 1 }]))' },
				{ name: "parallel-error", code: 'parallel([-> { raise "fixture-error" }, -> { 1 }])' },
				{ name: "pipeline", code: 'display(pipeline([1, 2], ->(x) { x + 1 }, ->(x) { x * 2 }))' },
				{ name: "log-phase", code: 'log("fixture-log"); phase("fixture-phase")' },
			];
		case "jl":
			return [
				{ name: "display-json", code: 'display(Dict("answer" => 42, "nested" => [nothing, true]))' },
				{ name: "display-markdown", code: 'display(Dict("type" => "markdown", "text" => "**fixture**"))' },
				{ name: "display-image", code: `display_image(${JSON.stringify(png)})` },
				{ name: "display-tool-images", code: `gate_images = [Dict("mimeType" => "image/png", "dataBase64" => ${JSON.stringify(png)})]; display(Dict("text" => "image fixture", "images" => gate_images)); display(gate_images[1])` },
				{ name: "print", code: 'print("head"); text("tail")' },
				{ name: "read-write", code: 'write("plain.txt", "plain"); display(read("plain.txt")); write("local://fixture.txt", "local"); display(read("local://fixture.txt"))' },
				{ name: "traversal", code: 'read("local://../escape")' },
				{ name: "env", code: 'env("GATE_VALUE", "value"); display(env("GATE_VALUE")); display(haskey(env(), "GATE_VALUE"))' },
				{ name: "tool", code: 'display(tool.fixture(Dict("value" => 42)))' },
				{ name: "tool-error", code: 'tool.failure(Dict())' },
				{ name: "schema", code: 'display(tool_schema("fixture"))' },
				{ name: "completion", code: 'display(completion("fixture")); display(completion("fixture"; schema=Dict("type" => "object")))' },
				{ name: "agent", code: 'display(agent("fixture")); display(agent("fixture"; schema=Dict("type" => "object"))); display(agent("fixture"; handle=true)); display(agent("fixture-null-handle"; handle=true))' },
				{ name: "output", code: 'display(output("st_fixture")); display(output("st_fixture"; format="tail"))' },
				{ name: "parallel", code: 'display(parallel([() -> 2, () -> 1]))' },
				{ name: "parallel-error", code: 'parallel([() -> error("fixture-error"), () -> 1])' },
				{ name: "pipeline", code: 'display(pipeline([1, 2], x -> x + 1, x -> x * 2))' },
				{ name: "log-phase", code: 'log("fixture-log"); phase("fixture-phase")' },
			];
		default:
			return assertNever(language);
	}
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported gate language: ${value}`);
}
