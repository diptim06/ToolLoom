/**
 * Types for npm package resolution and extraction.
 */

export interface VersionDist {
  tarball: string;
  shasum?: string;
  integrity?: string;
  fileCount?: number;
  unpackedSize?: number;
}

export interface PackageVersionData {
  name: string;
  version: string;
  description?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  dist: VersionDist;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, PackageVersionData>;
  description?: string;
  time?: Record<string, string>;
}

export interface ResolvedPackageInfo {
  name: string;
  version: string;
  description: string;
  tarballUrl: string;
  tempWorkspacePath: string;
  packagePath: string;
  packageJson: Record<string, unknown>;
}

export interface SafetyLimits {
  maxDownloadBytes: number;
  maxUncompressedBytes: number;
  maxFileCount: number;
  networkTimeoutMs: number;
}

export const DEFAULT_SAFETY_LIMITS: SafetyLimits = {
  maxDownloadBytes: 50 * 1024 * 1024,      // 50 MB
  maxUncompressedBytes: 100 * 1024 * 1024, // 100 MB
  maxFileCount: 10_000,                    // 10,000 files
  networkTimeoutMs: 30_000,                // 30 seconds
};
