import * as path from 'path';
import { WorkspaceManager } from './workspace';
import { fetchPackageMetadata, resolveLatestStableVersion } from './registry';
import { downloadTarball } from './downloader';
import { extractTarball } from './extractor';
import { ResolvedPackageInfo, SafetyLimits, DEFAULT_SAFETY_LIMITS } from './types';

export interface ResolveOptions {
  packageName: string;
  signal?: AbortSignal;
  onProgress?: (step: string) => void;
  limits?: SafetyLimits;
}

/**
 * Resolves an npm package, downloads its tarball to an isolated temporary workspace,
 * safely extracts it, and parses its package metadata.
 */
export async function resolveAndDownloadPackage(
  workspaceManager: WorkspaceManager,
  options: ResolveOptions
): Promise<ResolvedPackageInfo> {
  const { packageName, signal, onProgress, limits = DEFAULT_SAFETY_LIMITS } = options;

  let tempWorkspacePath: string | null = null;

  try {
    // Step 1: Query npm registry for metadata
    onProgress?.(`Querying npm registry for "${packageName}"...`);
    const packument = await fetchPackageMetadata(packageName, signal, limits.networkTimeoutMs);

    // Step 2: Resolve latest stable version
    onProgress?.('Resolving latest stable version...');
    const { version, data: versionData } = resolveLatestStableVersion(packument);

    const tarballUrl = versionData.dist?.tarball;
    if (!tarballUrl) {
      throw new Error(`Package "${packument.name}@${version}" does not have a tarball URL in registry metadata.`);
    }

    // Step 3: Create temporary workspace
    onProgress?.('Creating isolated temporary workspace...');
    tempWorkspacePath = await workspaceManager.createTempWorkspace();

    // Step 4: Download tarball
    onProgress?.(`Downloading ${packument.name}@${version} tarball...`);
    const tarballFile = path.join(tempWorkspacePath, 'package.tgz');
    await downloadTarball(tarballUrl, tarballFile, signal, limits);

    // Step 5: Extract archive
    onProgress?.('Extracting package archive safely...');
    const extractionDir = path.join(tempWorkspacePath, 'extracted');
    const extractionResult = await extractTarball(tarballFile, extractionDir, signal, limits);

    // Track workspace for session cleanup
    workspaceManager.trackWorkspace(tempWorkspacePath);

    const description =
      (typeof extractionResult.packageJson.description === 'string'
        ? extractionResult.packageJson.description
        : packument.description) || 'No description provided.';

    return {
      name: packument.name,
      version,
      description,
      tarballUrl,
      tempWorkspacePath,
      packagePath: extractionResult.packageRoot,
      packageJson: extractionResult.packageJson,
    };
  } catch (err) {
    // If anything fails, clean up the temporary workspace immediately
    if (tempWorkspacePath) {
      await workspaceManager.cleanupWorkspace(tempWorkspacePath);
    }
    throw err;
  }
}
