/**
 * The check that keeps a lazily-derived file (thumbnail, vision or display
 * variant) from outliving the original it was made from.
 *
 * `DiskMediaStore.delete` unlinks the original and then each derived name, and
 * a generation that is mid-encode at that moment finishes anyway: it holds the
 * bytes (or an open fd) already, so the unlink doesn't stop it. Its rename then
 * lands AFTER the store's unlink of the same name found nothing there, and the
 * derived file is left on disk with no row pointing at it — nothing ever reaps
 * it. Typical trigger: "Delete forever" on the Recently deleted page while its
 * cold tiles are still generating.
 *
 * So each generator calls this after its rename: if the original is gone, the
 * file it just wrote is unlinked again. A delete that starts after this check
 * is not a race at all — its own unlink sees the derived file and removes it.
 */
import { stat, unlink } from 'node:fs/promises';
import { createLogger } from '../log';

const log = createLogger('derived-orphan');

/**
 * True when `sourceAbs` no longer exists, having unlinked `derivedAbs`. Only
 * ENOENT counts as gone: any other stat failure (EIO from a soft NFS mount) is
 * a volume blip, and a derived file the original still owns must not be thrown
 * away over one.
 */
export async function discardIfOriginalGone(
	sourceAbs: string,
	derivedAbs: string,
): Promise<boolean> {
	try {
		await stat(sourceAbs);
		return false;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
	}
	try {
		await unlink(derivedAbs);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
			log.warn(`could not remove ${derivedAbs}, whose original was deleted:`, e);
		}
	}
	return true;
}
