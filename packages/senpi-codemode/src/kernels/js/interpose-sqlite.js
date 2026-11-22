import { checkPath, executionPath, replaceMethod } from "./interpose-paths.js";

// Skip quoted data/identifiers and comments, retaining semicolons to examine every statement.
function sqlWords(sql) {
	return String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/gu, " ")
		.toUpperCase().match(/[A-Z_]+|;/gu) ?? [];
}

function reachesOtherFile(sql) {
	let first;
	for (const word of sqlWords(sql)) {
		if (word === ";") { first = undefined; continue; }
		first ??= word;
		if (first === "ATTACH" || (first === "VACUUM" && word === "INTO")) return true;
	}
	return false;
}

export function installSqlitePermissions(check) {
	const paths = new WeakMap();
	const memory = (path) => path === ":memory:" || path === "";
	const file = (path, mode) => { if (!memory(path)) checkPath(check, mode, path); };
	const refuse = () => check(() => ({ unsupported: true }));
	const guardSql = (sql) => check(() => ({ granted: true, unsupported: reachesOtherFile(sql) }));
	const install = (sqlite, name, node) => {
		const Original = sqlite[name];
		if (!Original) return;
		const readonly = (options) => node ? options?.readOnly === true
			: typeof options === "number" ? (options & sqlite.constants.SQLITE_OPEN_READONLY) !== 0 : options?.readonly === true;
		const opening = (path, options) => {
			if (node && options?.allowExtension) refuse();
			file(path, "read");
			if (!readonly(options)) file(path, "write");
		};
		const proto = Original.prototype;
		const statement = (node ? sqlite.StatementSync : sqlite.Statement)?.prototype;
		for (const method of ["run", "get", "all", "iterate", "values"]) replaceMethod(statement, method, (original) => function (...args) {
			check(() => ({ granted: true }));
			const result = original.apply(this, args);
			if (method === "iterate") replaceMethod(result, "next", (next) => function (...parameters) {
				check(() => ({ granted: true }));
				return next.apply(this, parameters);
			});
			return result;
		});
		if (node) {
			const setAuthorizer = proto.setAuthorizer;
			replaceMethod(proto, "setAuthorizer", () => function (callback) {
				return setAuthorizer.call(this, (operation, ...args) => {
					if (operation === sqlite.constants.SQLITE_ATTACH) refuse();
					return callback?.(operation, ...args) ?? sqlite.constants.SQLITE_OK;
				});
			});
		}
		for (const method of ["exec", "run", "prepare", "query"]) replaceMethod(proto, method, (original) => function (sql, ...args) {
			// Also guards runtimes which translate SQLite authorizer throws to SQLITE_AUTH.
			guardSql(sql);
			return original.call(this, sql, ...args);
		});
		replaceMethod(proto, "enableLoadExtension", (original) => function (enabled) {
			if (enabled) refuse();
			return original.call(this, enabled);
		});
		replaceMethod(proto, "loadExtension", (original) => function (...args) {
			refuse();
			return original.apply(this, args);
		});
		sqlite[name] = new Proxy(Original, {
			construct(target, args, newTarget) {
				const [path = ":memory:", options] = args;
				opening(path, options);
				const actual = memory(path) ? path : executionPath(path);
				const db = Reflect.construct(target, [actual, ...args.slice(1)], newTarget);
				paths.set(db, path);
				if (node && typeof db.setAuthorizer === "function") db.setAuthorizer(null);
				return db;
			},
		});
		if (sqlite.default === Original) sqlite.default = sqlite[name];
		if (!node) {
			replaceMethod(Original, "open", (original) => function (path, options) {
				opening(path, options);
				const db = original.call(this, memory(path) ? path : executionPath(path), options);
				paths.set(db, path);
				return db;
			});
			replaceMethod(Original, "setCustomSQLite", (original) => function (...args) {
				refuse();
				return original.apply(this, args);
			});
		}
		if (node) replaceMethod(sqlite, "backup", (original) => function (db, dest, ...args) {
			file(paths.get(db), "read");
			file(dest, "write");
			return original.call(this, db, executionPath(dest), ...args);
		});
	};
	const nodeSqlite = process.getBuiltinModule("node:sqlite");
	install(nodeSqlite, "DatabaseSync", true);
	if (globalThis.Bun) {
		const require = process.getBuiltinModule("node:module").createRequire(import.meta.url);
		install(require("bun:sqlite"), "Database", false);
	}
}
