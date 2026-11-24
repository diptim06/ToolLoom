import * as vscode from 'vscode';
import { WorkspaceManager } from './npm/workspace';
import { normalizeAndValidatePackageName } from './npm/registry';
import { resolveAndDownloadPackage } from './npm/resolver';

let workspaceManager: WorkspaceManager | null = null;
let isResolving = false;

export function activate(context: vscode.ExtensionContext) {
  workspaceManager = new WorkspaceManager();

  // Create dedicated output channel for Toolloom
  const outputChannel = vscode.window.createOutputChannel('Toolloom');
  context.subscriptions.push(outputChannel);

  // Register workspace cleanup on extension disposal
  context.subscriptions.push({
    dispose: () => {
      workspaceManager?.cleanupAll();
    },
  });

  const disposable = vscode.commands.registerCommand('toolloom.start', async () => {
    // Prevent duplicate concurrent invocations
    if (isResolving) {
      vscode.window.showWarningMessage('Toolloom is already resolving a package. Please wait for it to finish.');
      return;
    }

    const input = await vscode.window.showInputBox({
      title: 'Convert Package to MCP',
      prompt: 'Enter an npm package name to resolve and extract',
      placeHolder: 'e.g. lodash, date-fns, axios, @types/node',
      validateInput: (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Package name cannot be empty.';
        }
        try {
          normalizeAndValidatePackageName(trimmed);
          return null;
        } catch (err: unknown) {
          return err instanceof Error ? err.message : 'Invalid package name.';
        }
      },
    });

    // Handle cancellation gracefully
    if (input === undefined) {
      return;
    }

    const packageName = input.trim();
    if (!packageName) {
      return;
    }

    isResolving = true;
    const abortController = new AbortController();

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Toolloom',
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            abortController.abort();
          });

          outputChannel.appendLine(`\n[${new Date().toLocaleTimeString()}] Starting resolution for "${packageName}"...`);

          const res = await resolveAndDownloadPackage(workspaceManager!, {
            packageName,
            signal: abortController.signal,
            onProgress: (step: string) => {
              progress.report({ message: step });
              outputChannel.appendLine(`  -> ${step}`);
            },
          });

          // Log detailed package information to output channel
          outputChannel.appendLine('--------------------------------------------------');
          outputChannel.appendLine('Toolloom: Package Resolved & Extracted Successfully');
          outputChannel.appendLine(`  Package Name:       ${res.name}`);
          outputChannel.appendLine(`  Resolved Version:   ${res.version}`);
          outputChannel.appendLine(`  Description:        ${res.description}`);
          outputChannel.appendLine(`  Tarball URL:        ${res.tarballUrl}`);
          outputChannel.appendLine(`  Workspace Path:     ${res.tempWorkspacePath}`);
          outputChannel.appendLine(`  Extracted Location: ${res.packagePath}`);
          outputChannel.appendLine('--------------------------------------------------');

          return res;
        }
      );

      // Display concise success notification
      const action = await vscode.window.showInformationMessage(
        `Toolloom: Successfully resolved and extracted ${result.name}@${result.version}`,
        'View Details'
      );

      if (action === 'View Details') {
        outputChannel.show(true);
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        outputChannel.appendLine('  [!] Operation was cancelled by user.');
        vscode.window.showInformationMessage('Toolloom: Package resolution cancelled.');
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`  [ERROR] ${errorMessage}`);
        const action = await vscode.window.showErrorMessage(`Toolloom: ${errorMessage}`, 'Show Details');
        if (action === 'Show Details') {
          outputChannel.show(true);
        }
      }
    } finally {
      isResolving = false;
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {
  if (workspaceManager) {
    workspaceManager.cleanupAll();
    workspaceManager = null;
  }
}
