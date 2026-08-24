/**
 * @typedef {object} CleanupCandidate
 * @property {string} bucket_id
 * @property {string} remote_path
 * @property {string | null} user_id
 * @property {string | null} meeting_id
 * @property {string | null} sequence
 * @property {string | null} storage_object_id
 * @property {boolean} metadata_exists
 */

/**
 * @param {CleanupCandidate[]} candidates
 * @param {{
 *   removeObject: (path: string) => Promise<void>,
 *   removeMetadata: (bucket: string, path: string) => Promise<void>,
 *   log: (event: { event: string, candidate: CleanupCandidate }) => void,
 * }} ports
 */
export async function cleanupCandidates(candidates, ports) {
  let deleted = 0;
  let metadataDeleted = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      await ports.removeObject(candidate.remote_path);
      deleted += 1;
    } catch {
      failed += 1;
      ports.log({ event: "storage_delete_failed", candidate });
      continue;
    }

    if (!candidate.metadata_exists) continue;

    try {
      await ports.removeMetadata(candidate.bucket_id, candidate.remote_path);
      metadataDeleted += 1;
    } catch {
      failed += 1;
      ports.log({ event: "metadata_delete_failed", candidate });
    }
  }

  return { deleted, metadataDeleted, failed };
}

/**
 * @param {number} scanned
 * @param {number} batchLimit
 * @param {() => Promise<boolean>} probe
 */
export async function determineMoreCandidates(scanned, batchLimit, probe) {
  if (scanned < batchLimit) return false;
  return probe();
}
