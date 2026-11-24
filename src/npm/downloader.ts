import * as fs from 'fs';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { DEFAULT_SAFETY_LIMITS, SafetyLimits } from './types';

/**
 * Downloads a package tarball to a destination file path safely.
 */
export async function downloadTarball(
  tarballUrl: string,
  destinationPath: string,
  signal?: AbortSignal,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS
): Promise<void> {
  const parsedUrl = new URL(tarballUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Insecure or unsupported tarball protocol: ${parsedUrl.protocol}`);
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), limits.networkTimeoutMs);

  const onAbort = () => timeoutController.abort();
  if (signal) {
    signal.addEventListener('abort', onAbort);
  }

  let fileStream: fs.WriteStream | null = null;

  try {
    const response = await fetch(tarballUrl, {
      method: 'GET',
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to download package tarball (HTTP ${response.status} ${response.statusText})`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (contentLength > limits.maxDownloadBytes) {
        throw new Error(
          `Package tarball size (${Math.round(contentLength / 1024 / 1024)}MB) exceeds limit of ${Math.round(
            limits.maxDownloadBytes / 1024 / 1024
          )}MB.`
        );
      }
    }

    if (!response.body) {
      throw new Error('Received empty response body for tarball download.');
    }

    fileStream = fs.createWriteStream(destinationPath);
    let downloadedBytes = 0;

    // Convert web stream to Node readable stream
    const nodeReadable = Readable.fromWeb(response.body as import('stream/web').ReadableStream);

    nodeReadable.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      if (downloadedBytes > limits.maxDownloadBytes) {
        timeoutController.abort();
        throw new Error(
          `Package tarball download exceeded limit of ${Math.round(limits.maxDownloadBytes / 1024 / 1024)}MB.`
        );
      }
    });

    nodeReadable.pipe(fileStream);

    await finished(fileStream);
  } catch (err: unknown) {
    // Clean up partial file on failure
    if (fileStream) {
      try {
        fileStream.close();
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(destinationPath)) {
      try {
        await fs.promises.unlink(destinationPath);
      } catch {
        // ignore
      }
    }

    if (signal?.aborted) {
      throw new Error('Package download was cancelled.');
    }
    if (timeoutController.signal.aborted) {
      throw new Error(`Package download timed out after ${limits.networkTimeoutMs / 1000} seconds.`);
    }

    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
