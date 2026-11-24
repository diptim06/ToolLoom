import { Packument, PackageVersionData } from './types';

/**
 * Validates and normalizes an npm package name.
 * Supports standard packages and scoped packages (@scope/name).
 */
export function normalizeAndValidatePackageName(input: string): string {
  const normalized = input.trim().toLowerCase();

  if (!normalized) {
    throw new Error('Package name cannot be empty.');
  }

  if (normalized.length > 214) {
    throw new Error('Package name cannot exceed 214 characters.');
  }

  // Regex matching npm package name rules (scoped or unscoped)
  const scopedPattern = /^@[a-z0-9_~.-]+\/[a-z0-9_~.-]+$/;
  const unscopedPattern = /^[a-z0-9_~.-]+$/;

  if (normalized.startsWith('@')) {
    if (!scopedPattern.test(normalized)) {
      throw new Error(`Invalid scoped package name "${input}". Expected format: @scope/package`);
    }
    const [scopePart, namePart] = normalized.slice(1).split('/');
    if (scopePart.startsWith('.') || scopePart.startsWith('_') || namePart.startsWith('.') || namePart.startsWith('_')) {
      throw new Error(`Package name cannot have scopes or names starting with "." or "_".`);
    }
  } else {
    if (!unscopedPattern.test(normalized)) {
      throw new Error(`Invalid package name "${input}". Names must be lowercase and contain only URL-safe characters.`);
    }
    if (normalized.startsWith('.') || normalized.startsWith('_')) {
      throw new Error(`Package name cannot start with "." or "_".`);
    }
  }

  return normalized;
}

/**
 * Compares two SemVer versions [major, minor, patch].
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] | null => {
    const match = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  };

  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) {
    return a.localeCompare(b);
  }
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  return pa[2] - pb[2];
}

/**
 * Resolves the latest stable version from packument versions.
 * Avoids prerelease versions (containing hyphens) by default.
 */
export function resolveLatestStableVersion(packument: Packument): { version: string; data: PackageVersionData } {
  const latestTag = packument['dist-tags']?.latest;
  const allVersions = Object.keys(packument.versions || {});

  if (allVersions.length === 0) {
    throw new Error(`Package "${packument.name}" has no published versions.`);
  }

  // Check if dist-tags.latest is a stable version (no hyphen)
  if (latestTag && packument.versions[latestTag]) {
    const isPrerelease = latestTag.includes('-');
    if (!isPrerelease) {
      return {
        version: latestTag,
        data: packument.versions[latestTag],
      };
    }
  }

  // If latest tag is a prerelease or missing, filter all stable versions
  const stableVersions = allVersions.filter((v) => !v.includes('-') && /^\d+\.\d+\.\d+$/.test(v));

  if (stableVersions.length > 0) {
    stableVersions.sort(compareSemver);
    const highestStable = stableVersions[stableVersions.length - 1];
    return {
      version: highestStable,
      data: packument.versions[highestStable],
    };
  }

  // If no stable versions exist at all, fall back to dist-tags.latest or highest version
  const fallbackVersion = latestTag && packument.versions[latestTag]
    ? latestTag
    : allVersions.sort(compareSemver)[allVersions.length - 1];

  return {
    version: fallbackVersion,
    data: packument.versions[fallbackVersion],
  };
}

/**
 * Fetches package metadata from the npm registry.
 */
export async function fetchPackageMetadata(
  packageName: string,
  signal?: AbortSignal,
  timeoutMs = 15000
): Promise<Packument> {
  const normalized = normalizeAndValidatePackageName(packageName);

  // Encode package name properly for registry: @scope/name -> @scope%2Fname
  let registryPath: string;
  if (normalized.startsWith('@')) {
    const [scope, name] = normalized.split('/');
    registryPath = `${encodeURIComponent(scope)}%2F${encodeURIComponent(name)}`;
  } else {
    registryPath = encodeURIComponent(normalized);
  }

  const url = `https://registry.npmjs.org/${registryPath}`;

  // Combine timeout and abort signal
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  const onAbort = () => timeoutController.abort();
  if (signal) {
    signal.addEventListener('abort', onAbort);
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: timeoutController.signal,
    });

    if (response.status === 404) {
      throw new Error(`Package "${normalized}" not found on the npm registry.`);
    }

    if (!response.ok) {
      throw new Error(`npm registry error: HTTP ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Packument;
    if (!data || typeof data !== 'object' || !data.name) {
      throw new Error(`Received invalid metadata response for package "${normalized}".`);
    }

    return data;
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw new Error('Package resolution was cancelled.');
    }
    if (timeoutController.signal.aborted) {
      throw new Error(`npm registry request timed out after ${timeoutMs / 1000} seconds.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
