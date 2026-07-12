import { readdirSync, existsSync, readFileSync } from 'node:fs';

/**
 * Returns true when the current process is running inside WSL (Windows
 * Subsystem for Linux). Checks /proc/version for the "microsoft" or "WSL"
 * string which is present in all WSL 1 and WSL 2 kernels.
 */
export function isWsl(): boolean {
  try {
    const version = readFileSync('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Tool-data directories on the Windows side, for use when running under WSL.
 * Scans every /mnt/c/Users/<profile>/<relPath> and returns the ones that
 * exist. It looks for the data directly rather than guessing the Windows
 * username — USERPROFILE is often unset under WSL, and the first
 * /mnt/c/Users entry can be a sandbox/system account (e.g.
 * "CodexSandboxOffline"), not the real user. Returns [] when off WSL.
 */
export function scanWindowsUserDirs(relPath: string): string[] {
  if (!isWsl()) return [];
  const usersRoot = '/mnt/c/Users';
  const out: string[] = [];
  try {
    for (const e of readdirSync(usersRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const candidate = `${usersRoot}/${e.name}/${relPath}`;
      if (existsSync(candidate)) out.push(candidate);
    }
  } catch {
    /* /mnt/c/Users absent — not a typical WSL-on-Windows setup */
  }
  return out;
}
