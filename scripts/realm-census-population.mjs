// Realm census (design #12965, 3.3): the population. Every module-scope binding and static class field in a root whose
// initializer can hold state. Every `let` and `var` counts, and so does every non-readonly static field, since both
// can be reassigned like module state.
import { join, relative } from "node:path";

import {
	initializerKind,
	isAsyncLocalStorage,
	isExemptInitializer,
	isRealmRegistryCall,
	memberName,
	patternNames,
	unwrap,
} from "./realm-census-initializers.mjs";
import { parseFile, sourceFiles, toPosix, walk } from "./realm-census-source.mjs";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** Every module-scope binding and static class field in one file whose initializer can hold state. */
function fileBindings(root, absolutePath) {
	const file = toPosix(relative(root, absolutePath));
	const { program, line } = parseFile(absolutePath);
	const found = [];
	const add = (name, node, kind, als, registry = false) =>
		found.push({ file, name, line: line(node.start), kind, als, registry });

	const checkClass = (classNode, className) => {
		for (const member of classNode.body.body) {
			const field = member.type === "PropertyDefinition" || member.type === "AccessorProperty";
			if (!field || !member.static || member.declare) continue;
			const name = `${className}.${memberName(member)}`;
			const mutable = member.type === "AccessorProperty" || !member.readonly;
			if (mutable || !isExemptInitializer(member.value)) {
				const kind = `static ${member.readonly ? "readonly " : ""}${initializerKind(member.value, mutable ? "" : "const")}`;
				add(name, member, kind, isAsyncLocalStorage(member.value));
			}
		}
	};

	// Variable declarations directly in the module (or a namespace body) and `var` anywhere outside a function body are
	// evaluated once per module instance. Classes outside a function body are evaluated once too.
	walk(
		program,
		(node, parent) => {
			const insideFunction = parent?.info?.insideFunction === true || FUNCTION_TYPES.has(parent?.node.type);
			const info = { insideFunction, className: parent?.info?.className };
			// Ambient declarations (`declare global`, `declare module`) emit no runtime binding.
			if (node.type === "TSModuleDeclaration" && (node.declare || node.kind === "global")) return false;
			if (FUNCTION_TYPES.has(node.type) || node.type === "StaticBlock") return { ...info, insideFunction: true };
			if (insideFunction) return info;
			if (node.type === "VariableDeclaration" && !node.declare) {
				const container = parent?.node.type === "ExportNamedDeclaration" ? undefined : parent?.node.type;
				const moduleLevel =
					container === undefined ||
					container === "Program" ||
					container === "TSModuleBlock" ||
					node.kind === "var";
				if (moduleLevel) {
					for (const declarator of node.declarations) {
						const names = patternNames(declarator.id);
						const counted =
							node.kind !== "const" ||
							declarator.init === null ||
							declarator.id.type !== "Identifier" ||
							!isExemptInitializer(declarator.init, declarator.id.typeAnnotation != null);
						if (!counted) continue;
						for (const name of names) {
							add(
								name,
								declarator,
								initializerKind(declarator.init, node.kind),
								isAsyncLocalStorage(declarator.init),
								isRealmRegistryCall(declarator.init),
							);
						}
					}
				}
				return info;
			}
			if (node.type === "VariableDeclarator" && node.init && unwrap(node.init)?.type === "ClassExpression") {
				return { ...info, className: node.id.type === "Identifier" ? node.id.name : undefined };
			}
			if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
				const className =
					node.id?.name ??
					(node.type === "ClassExpression" ? info.className : undefined) ??
					(parent?.node.type === "ExportDefaultDeclaration" ? "default" : "<anonymous>");
				checkClass(node, className);
				return { ...info, className: undefined };
			}
			if (node.type === "ExportDefaultDeclaration") {
				const declaration = node.declaration;
				const isDeclaration =
					declaration.type === "FunctionDeclaration" ||
					declaration.type === "ClassDeclaration" ||
					declaration.type === "TSInterfaceDeclaration";
				if (!isDeclaration && !isExemptInitializer(declaration)) {
					add(
						"default",
						node,
						`export default ${initializerKind(declaration, "const")}`,
						isAsyncLocalStorage(declaration),
					);
				}
			}
			return info;
		},
		undefined,
	);

	// A file that creates no realm registry cannot hold a realm-registry binding.
	let createsRegistry = false;
	walk(program, (node) => {
		if (isRealmRegistryCall(node)) createsRegistry = true;
	});
	for (const binding of found) binding.fileCreatesRegistry = createsRegistry;

	// Keys: <file>#<name>; a name that occurs twice in one file gets @<line> on every occurrence.
	const counts = new Map();
	for (const binding of found) counts.set(binding.name, (counts.get(binding.name) ?? 0) + 1);
	for (const binding of found) {
		binding.key = `${file}#${binding.name}${counts.get(binding.name) > 1 ? `@${binding.line}` : ""}`;
	}
	return found;
}

export function collectPopulation(root, roots) {
	return roots.flatMap((dir) =>
		sourceFiles(join(root, "packages", dir, "src")).flatMap((file) => fileBindings(root, file)),
	);
}
