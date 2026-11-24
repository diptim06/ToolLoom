import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Manages isolated temporary workspaces for package downloads and extractions.
 */
export class WorkspaceManager {
  private trackedWorkspaces: Set<string> = new Set();

  /**
   * Creates a dedicated temporary directory outside the user's project.
   */
  async createTempWorkspace(): Promise<string> {
    const baseDir = path.join(os.tmpdir(), 'toolloom-workspaces');
    await fs.promises.mkdir(baseDir, { recursive: true });
    const prefix = path.join(baseDir, `pkg-${Date.now()}-`);
    const tempDir = await fs.promises.mkdtemp(prefix);
    return tempDir;
  }

  /**
   * Tracks a successfully created workspace for lifecycle cleanup.
   */
  trackWorkspace(dirPath: string): void {
    this.trackedWorkspaces.add(dirPath);
  }

  /**
   * Deletes a specific workspace immediately.
   */
  async cleanupWorkspace(dirPath: string): Promise<void> {
    this.trackedWorkspaces.delete(dirPath);
    try {
      if (fs.existsSync(dirPath)) {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
      }
    } catch (err) {
      // Best effort deletion; log or ignore
    }
  }

  /**
   * Deletes all tracked workspaces (e.g. when the extension deactivates).
   */
  async cleanupAll(): Promise<void> {
    const list = Array.from(this.trackedWorkspaces);
    this.trackedWorkspaces.clear();
    for (const dirPath of list) {
      try {
        if (fs.existsSync(dirPath)) {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
        }
      } catch {
        // Best effort
      }
    }
  }
}
