import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Reads .filesignore from the root of a local source and returns a matcher function.
 * Supports glob-style patterns (fnmatch-like):
 *   - Lines starting with # are comments
 *   - Blank lines are skipped
 *   - Patterns ending with / match directories only
 *   - * matches anything except /
 *   - ** matches anything including /
 */

export function loadIgnorePatterns(rootPath: string): (relPath: string, isDir: boolean) => boolean {
  const ignorePath = join(rootPath, ".filesignore");
  if (!existsSync(ignorePath)) return () => false;

  const lines = readFileSync(ignorePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const patterns = lines.map((line) => {
    const dirOnly = line.endsWith("/");
    const pat = dirOnly ? line.slice(0, -1) : line;
    return { pat, dirOnly, rx: globToRegex(pat) };
  });

  return (relPath: string, isDir: boolean): boolean => {
    for (const { rx, dirOnly } of patterns) {
      if (dirOnly && !isDir) continue;
      if (rx.test(relPath) || rx.test(relPath.split("/").pop()!)) return true;
    }
    return false;
  };
}

function globToRegex(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++; // skip second *
      if (glob[i + 1] === "/") i++; // skip trailing slash
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === ".") {
      re += "\\.";
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}
