import type { RunPythonPostFile } from './pool';

/**
 * Append one line to an interpreter call's `stderr` naming generated files that
 * could not be saved, so the model doesn't tell the user they're attached.
 */
export function appendUnsavedFilesWarning(
	stderr: string,
	files: ReadonlyArray<Pick<RunPythonPostFile, 'filename'>>,
): string {
	const warning = `[could not save ${files.map((f) => f.filename).join(', ')}; these files are NOT attached]`;
	return stderr === '' || stderr.endsWith('\n') ? stderr + warning : `${stderr}\n${warning}`;
}
