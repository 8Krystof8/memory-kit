// Which path later runs should start the Node.js running now (process.execPath) by: an MCP config,
// a hook, a command handed to the agent or the user. Package managers delete some versioned
// folders by themselves, so those give their stable link instead: a Homebrew Cellar folder (macOS
// and Linuxbrew; `brew upgrade` removes the old one) its <prefix>/bin/node or
// <prefix>/opt/<formula>/bin/node, a snap revision folder (/snap/node/<rev>; snapd keeps two and
// refreshes by itself) /snap/<name>/current, and, for hooks and commands, an fnm multishell folder
// (one per terminal, deleted later) the real path behind it. commandNode() words it for a shell:
// a repository that pins an older Node.js (nvm, fnm, volta, mise, asdf) then cannot change which
// Node.js a command runs on, which a bare `node` would.

import fs from 'node:fs';

function realpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * The stable path of execPath (see above). realpath: a function giving the real path or null
 * (tests replace it). multishell false leaves an fnm multishell path as it is (MCP configs).
 */
export function stableNodePath(execPath, { platform = process.platform, realpath = realpathOrNull, multishell = true } = {}) {
  const p = String(execPath);
  if (platform !== 'win32') {
    const cellar = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(p);
    if (cellar) {
      const [, prefix, formula] = cellar;
      for (const link of [`${prefix}/bin/node`, `${prefix}/opt/${formula}/bin/node`]) {
        const real = realpath(link);
        if (real && real.startsWith(`${prefix}/Cellar/${formula}/`)) return link;
      }
      return p;
    }
    const snap = platform === 'linux' ? /^\/snap\/([^/]+)\/(?!current\/)[^/]+\/(.+)$/.exec(p) : null;
    if (snap) {
      const link = `/snap/${snap[1]}/current/${snap[2]}`;
      const real = realpath(link);
      return real && real.startsWith(`/snap/${snap[1]}/`) ? link : p;
    }
  }
  if (multishell && /[\\/]fnm_multishells[\\/]/i.test(p)) return realpath(p) ?? p;
  return p;
}

// A word every shell reads as it is, without quotes: letters of any script, digits, _ . / : + ~ -.
const BARE_WORD = /^[\p{L}\p{N}_./:+][\p{L}\p{N}_./:+~-]*$/u;

/**
 * The Node.js running now as the first word of a command to paste into any shell: on macOS and
 * Linux its stable path in double quotes; on Windows the path with forward slashes when it needs
 * no quotes (PowerShell would take a quoted first word for a string), else `node`. `node` too
 * when the path holds a character a shell would expand.
 */
export function commandNode({ execPath = process.execPath, platform = process.platform, realpath } = {}) {
  const p = stableNodePath(execPath, { platform, ...(realpath ? { realpath } : {}) });
  if (platform === 'win32') {
    const word = p.replace(/\\/g, '/');
    return BARE_WORD.test(word) ? word : 'node';
  }
  return /["$`\\!\r\n]/.test(p) ? 'node' : `"${p}"`;
}
