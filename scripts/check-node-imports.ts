/**
 * Part of `pnpm check`: fails if anything the scripts in this directory reach
 * loads a module through a `#` subpath import (`#lib/...`) at runtime.
 *
 * The scripts run under plain `node`, which strips types but rewrites nothing.
 * `tsc -p scripts/tsconfig.json` (nodenext) already refuses the other ways the
 * graph can stop loading: an extensionless relative import, `$lib`, `$app`.
 * It can't refuse `#lib`: the tree imports it as `#lib/x.js`, TypeScript maps
 * that to `x.ts` and is satisfied, and node looks for `x.js`, which doesn't
 * exist. `resolvePackageJsonImports: false` and a `paths` override are both
 * ignored for this under nodenext, so the check walks the program's files.
 * `import type` is erased before node resolves anything, so it's allowed;
 * `import { type X }` is not — it still loads the module.
 */
import process from 'node:process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'scripts/tsconfig.json');
const config = ts.getParsedCommandLineOfConfigFile(
	configPath,
	{},
	{
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (d) => {
			throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
		},
	},
);
if (!config) throw new Error(`could not read ${configPath}`);

const program = ts.createProgram(config.fileNames, config.options);
const offenders: string[] = [];

function runtimeSpecifier(node: ts.Node): ts.Expression | undefined {
	if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) return node.moduleSpecifier;
	if (ts.isExportDeclaration(node) && !node.isTypeOnly) return node.moduleSpecifier;
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
		return node.arguments[0];
	}
	return undefined;
}

for (const sf of program.getSourceFiles()) {
	if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/')) continue;
	const visit = (node: ts.Node): void => {
		const spec = runtimeSpecifier(node);
		if (spec && ts.isStringLiteralLike(spec) && spec.text.startsWith('#')) {
			const { line } = sf.getLineAndCharacterOfPosition(spec.getStart(sf));
			offenders.push(`${relative(root, sf.fileName)}:${line + 1}: '${spec.text}'`);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
}

if (offenders.length > 0) {
	console.error(
		'Files reached from scripts/ must not use # subpath imports — node cannot ' +
			'resolve them (#lib/x.js names a file that only exists as .ts). ' +
			'Use a relative import with a .ts extension:\n  ' +
			offenders.join('\n  '),
	);
	process.exitCode = 1;
}
