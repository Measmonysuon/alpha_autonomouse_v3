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
