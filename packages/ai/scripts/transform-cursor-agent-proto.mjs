#!/usr/bin/env node
/**
 * Rewrites protoc-gen-es (v2, target=ts) output into erasable-syntax TypeScript.
 *
 * The repo compiles with `erasableSyntaxOnly`, which forbids TypeScript `enum`
 * declarations. protobuf-es only uses the generated TS enums for developer
 * ergonomics — runtime encode/decode reads the embedded binary file descriptor
 * (`fileDesc(...)`) — so each enum can be safely rewritten to a `const` object
 * plus a derived union type with identical value semantics.
 *
 * Regeneration workflow for packages/ai/src/api/cursor-agent/gen/agent_pb.ts:
 *
 *   1. npx --yes -p @bufbuild/buf -p @bufbuild/protoc-gen-es@2.13.0 \
 *        buf generate --template '{"version":"v2","plugins":[{"local":"protoc-gen-es","out":"OUT_DIR","opt":["target=ts"]}]}' \
 *        packages/ai/proto/cursor
 *   2. node packages/ai/scripts/transform-cursor-agent-proto.mjs OUT_DIR/agent_pb.ts \
 *        packages/ai/src/api/cursor-agent/gen/agent_pb.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	console.error("usage: transform-cursor-agent-proto.mjs <generated agent_pb.ts> <output path>");
	process.exit(1);
}

const source = readFileSync(input, "utf8");

const transformed = source.replace(
	/export enum (\w+) \{([^}]*)\}/g,
	(_match, name, body) => {
		const objectBody = body.replace(/^(\s*)([A-Za-z_$][\w$]*) = (-?\d+),?$/gm, "$1$2: $3,");
		return `export const ${name} = {${objectBody}} as const;\n\nexport type ${name} = (typeof ${name})[keyof typeof ${name}];`;
	},
);

if (/export enum /.test(transformed)) {
	console.error("transform incomplete: `export enum` still present in output");
	process.exit(1);
}

const header = `// Vendored from the upstream oh-my-pi Cursor agent protocol schema\n// (packages/ai/proto/cursor/agent.proto). TS enums are rewritten to erasable\n// const objects by packages/ai/scripts/transform-cursor-agent-proto.mjs.\n`;
writeFileSync(output, header + transformed);
console.log(`wrote ${output}`);
