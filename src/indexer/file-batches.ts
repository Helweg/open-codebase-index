export interface FileBatchLimits {
  maxFiles: number;
  maxBytes: number;
}

export const INDEX_FILE_BATCH_LIMITS: Readonly<FileBatchLimits> = Object.freeze({
  maxFiles: 64,
  maxBytes: 8 * 1024 * 1024,
});

export function* iterateOrderedFileBatches<T>(
  items: Iterable<T>,
  getBytes: (item: T) => number,
  limits: FileBatchLimits = INDEX_FILE_BATCH_LIMITS,
): Generator<T[]> {
  const maxFiles = Math.max(1, Math.floor(limits.maxFiles));
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes));
  let batch: T[] = [];
  let batchBytes = 0;

  for (const item of items) {
    const itemBytes = Math.max(0, Math.floor(getBytes(item)));
    if (batch.length > 0 && (batch.length >= maxFiles || batchBytes + itemBytes > maxBytes)) {
      yield batch;
      batch = [];
      batchBytes = 0;
    }

    batch.push(item);
    batchBytes += itemBytes;
  }

  if (batch.length > 0) {
    yield batch;
  }
}
