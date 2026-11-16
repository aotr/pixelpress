import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Write a file by way of a unique temporary file and an atomic rename.
 * The writer runs against the temp path and its return value is passed through.
 */
export async function writeAtomic(destination, writer) {
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );

  try {
    const result = await writer(temporary);
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      // Windows may refuse to replace an existing file with rename.
      // Copying is not atomic, but it is safer than deleting the old output.
      if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
        await fs.copyFile(temporary, destination);
      } else {
        throw error;
      }
    }
    return result;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function writeFileAtomic(destination, data) {
  return writeAtomic(destination, (temporary) => fs.writeFile(temporary, data));
}
