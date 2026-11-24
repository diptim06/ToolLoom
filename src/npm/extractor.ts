import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';
import { DEFAULT_SAFETY_LIMITS, SafetyLimits } from './types';

export interface ExtractionResult {
  packageRoot: string;
  packageJson: Record<string, unknown>;
  fileCount: number;
  totalSize: number;
}

/**
 * Waits for any active file write operations within node-tar to finish flushing
 * and close their file descriptors before performing cleanup.
 */
async function drainInFlightWrites(unpack: unknown): Promise<void> {
  if (!unpack || typeof unpack !== 'object') {
    return;
  }
  const pendingSym = Object.getOwnPropertySymbols(unpack).find(
    (s) => s.description === 'pending'
  );
  if (!pendingSym) {
    return;
  }
  const record = unpack as Record<symbol, unknown>;
  const start = Date.now();
  while (typeof record[pendingSym] === 'number' && (record[pendingSym] as number) > 0) {
    if (Date.now() - start > 5000) {
      break; // Safeguard against indefinite stall
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Safely extracts a package tarball into a destination directory with Tar Slip protection,
 * controllable streaming extraction, cancellation support, and size/file count limits.
 */
export async function extractTarball(
  tarballPath: string,
  destinationDir: string,
  signal?: AbortSignal,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS
): Promise<ExtractionResult> {
  if (signal?.aborted) {
    throw new Error('Package extraction was cancelled.');
  }

  await fs.promises.mkdir(destinationDir, { recursive: true });

  const canonicalDestDir = path.resolve(destinationDir);

  let fileCount = 0;
  let totalSize = 0;
  let extractionError: Error | null = null;
  let unpackStream: (tar.Unpack & { abort?: (err: Error) => void }) | null = null;
  let readStream: fs.ReadStream | null = null;

  try {
    readStream = fs.createReadStream(tarballPath);

    const abortTar = (err: Error) => {
      if (!extractionError) {
        extractionError = err;
      }
      if (readStream) {
        readStream.destroy();
      }
      if (unpackStream && typeof unpackStream.abort === 'function') {
        unpackStream.abort(err);
      }
    };

    const onAbort = () => {
      abortTar(new Error('Package extraction was cancelled.'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    unpackStream = tar.x({
      cwd: canonicalDestDir,
      filter: (entryPath: string, entry: tar.ReadEntry | fs.Stats) => {
        // Check cancellation
        if (signal?.aborted) {
          onAbort();
          return false;
        }

        // If an error already occurred, skip all remaining entries
        if (extractionError) {
          return false;
        }

        // Limit file count
        fileCount++;
        if (fileCount > limits.maxFileCount) {
          const err = new Error(
            `Archive file count limit exceeded (maximum ${limits.maxFileCount} files).`
          );
          abortTar(err);
          return false;
        }

        // Limit total uncompressed size
        totalSize += entry.size || 0;
        if (totalSize > limits.maxUncompressedBytes) {
          const err = new Error(
            `Archive uncompressed size limit exceeded (maximum ${Math.round(
              limits.maxUncompressedBytes / 1024 / 1024
            )}MB).`
          );
          abortTar(err);
          return false;
        }

        // Check path traversal (Zip Slip / Tar Slip)
        if (path.isAbsolute(entryPath)) {
          const err = new Error(`Malicious tar entry detected: absolute path "${entryPath}".`);
          abortTar(err);
          return false;
        }

        const resolvedEntryPath = path.resolve(canonicalDestDir, entryPath);
        const relativeToDest = path.relative(canonicalDestDir, resolvedEntryPath);

        if (relativeToDest.startsWith('..') || path.isAbsolute(relativeToDest)) {
          const err = new Error(
            `Malicious tar entry detected: path traversal attempt for "${entryPath}".`
          );
          abortTar(err);
          return false;
        }

        // Check link traversal for symlinks or hardlinks
        const entryType = (entry as { type?: string }).type;
        const linkpath = (entry as { linkpath?: string }).linkpath;
        if (linkpath && (entryType === 'SymbolicLink' || entryType === 'Link')) {
          if (path.isAbsolute(linkpath)) {
            const err = new Error(
              `Malicious tar link entry detected: absolute link path "${linkpath}".`
            );
            abortTar(err);
            return false;
          }

          // Hardlinks (Link) resolve relative to the extraction root (cwd),
          // while symbolic links (SymbolicLink) resolve relative to the entry's containing directory.
          const targetBase =
            entryType === 'Link'
              ? canonicalDestDir
              : path.dirname(resolvedEntryPath);

          const resolvedLink = path.resolve(targetBase, linkpath);
          const linkRel = path.relative(canonicalDestDir, resolvedLink);
          if (linkRel.startsWith('..') || path.isAbsolute(linkRel)) {
            const err = new Error(
              `Malicious tar link entry detected: link traversal attempt for "${linkpath}".`
            );
            abortTar(err);
            return false;
          }
        }

        return true;
      },
    }) as tar.Unpack & { abort?: (err: Error) => void };

    const extractPromise = new Promise<void>((resolve, reject) => {
      unpackStream!.on('error', (err: unknown) => {
        if (signal?.aborted && !extractionError) {
          extractionError = new Error('Package extraction was cancelled.');
        }
        reject(extractionError || err);
      });
      unpackStream!.on('close', () => {
        if (extractionError) {
          reject(extractionError);
        } else {
          resolve();
        }
      });
      readStream!.on('error', (err: unknown) => {
        reject(extractionError || err);
      });
    });

    readStream.pipe(unpackStream as unknown as NodeJS.WritableStream);

    try {
      await extractPromise;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }

    if (signal?.aborted) {
      throw new Error('Package extraction was cancelled.');
    }

    if (extractionError) {
      throw extractionError;
    }

    // Locate package.json inside extracted directory
    const packageInSubdir = path.join(canonicalDestDir, 'package', 'package.json');
    const packageAtRoot = path.join(canonicalDestDir, 'package.json');

    let packageRoot: string;
    let packageJsonPath: string;

    if (fs.existsSync(packageInSubdir)) {
      packageRoot = path.join(canonicalDestDir, 'package');
      packageJsonPath = packageInSubdir;
    } else if (fs.existsSync(packageAtRoot)) {
      packageRoot = canonicalDestDir;
      packageJsonPath = packageAtRoot;
    } else {
      throw new Error('Invalid package archive: package.json not found in extracted contents.');
    }

    // Read and parse package.json
    const rawContent = await fs.promises.readFile(packageJsonPath, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new Error('Extracted package.json is not valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Extracted package.json did not contain a valid JSON object.');
    }

    return {
      packageRoot,
      packageJson: parsed,
      fileCount,
      totalSize,
    };
  } catch (err) {
    // Ensure in-flight writes have stopped before deleting the extraction directory
    if (unpackStream) {
      await drainInFlightWrites(unpackStream);
    }

    try {
      if (fs.existsSync(canonicalDestDir)) {
        await fs.promises.rm(canonicalDestDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
    throw err;
  }
}
