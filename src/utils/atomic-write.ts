import * as fs from 'fs';
import * as path from 'path';

/**
 * Atomic file persistence.
 *
 * Writes content to a temporary file in the SAME directory, fsyncs it, then
 * renames over the target. Rename is atomic on POSIX filesystems, so a crash
 * or power loss mid-write can never leave a truncated/corrupt target file:
 * readers see either the complete old contents or the complete new contents.
 * Also prevents interleaved partial writes when several modules persist the
 * same JSON state file (settings.json is written from 5 places).
 */
export function writeFileAtomicSync(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, content, null, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/** Serialize a value as pretty JSON and persist it atomically. */
export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  writeFileAtomicSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Single-writer read-modify-write for shared JSON state files.
 *
 * Always re-reads the CURRENT on-disk contents, applies `mutator` to that
 * fresh copy, and persists atomically — synchronously, so no other writer in
 * this process can interleave between the read and the write. Every module
 * that updates settings.json goes through here, which makes lost updates
 * (one writer clobbering another's section with a stale copy) impossible.
 *
 * If the existing file is corrupt, this THROWS instead of silently resetting
 * it to {}: a damaged settings file must surface as an error and be repaired,
 * never quietly wiped.
 */
export function updateJsonFileSync<T extends Record<string, any>>(
  filePath: string,
  mutator: (current: T) => void,
): T {
  let current = {} as T;
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.trim() !== '') {
      current = JSON.parse(raw) as T;
    }
  }
  mutator(current);
  writeJsonAtomicSync(filePath, current);
  return current;
}
