#!/usr/bin/env node

/**
 * Makes a packaged runtime self-contained: removes every symlink/junction
 * under the given directory, then fails if any is left.
 *
 * Why this exists. On Windows npm resolves the workspace root — this
 * repository, whose package name is memmy-agent — as a file: dependency of a
 * nested install, so dist/runtime/memory/node_modules ends up holding a
 * junction to the repository root (npm ci insists on it: it treats a lockfile
 * without that entry as out of sync). electron-builder follows directory links
 * while it walks the app for app.asar, and the extraResources copy does the
 * same, so that one link makes packaging walk the repository, reach the same
 * link one level deeper, and repeat forever: no output, no app.asar, killed by
 * the job timeout. The packaged Memory runtime does not use that dependency;
 * it is an artifact of the workspace it was installed inside.
 *
 * Unlink, never rm -rf: on Windows, deleting a junction recursively deletes
 * what it points at — here, the repository.
 *
 * Usage: node detach-packaged-runtime-links.mjs <directory> [more directories]
 */

import { lstatSync, readdirSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node detach-packaged-runtime-links.mjs <directory> [more directories]");
  process.exit(2);
}

/**
 * Returns the links found under `root`, listing them and detaching them when
 * `detach` is set. Directories are only descended into as real directories:
 * a link is never followed, so a link that loops back into the tree cannot
 * hang this the way it hangs the walk this guards against.
 */
function scan(root, detach) {
  const found = [];
  let entries = 0;
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.pop();
    let names;
    try {
      names = readdirSync(directory);
    } catch (error) {
      // A runtime directory is allowed to be missing: not every packaging run
      // installs every runtime.
      console.log(`skipped ${directory}: ${error.code || error.message}`);
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      entries += 1;
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        console.log(`unstatable ${path}: ${error.code || error.message}`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target = "<unreadable>";
        try {
          target = readlinkSync(path);
        } catch (error) {
          target = `<unreadable: ${error.code || error.message}>`;
        }
        found.push({ path, target });
        if (detach) {
          unlinkSync(path);
          console.log(`detached ${path} -> ${target}`);
        }
        continue;
      }
      if (stat.isDirectory()) {
        queue.push(path);
      }
    }
  }
  return { found, entries };
}

let total = 0;
for (const root of roots) {
  const { found } = scan(root, true);
  total += found.length;
}

for (const root of roots) {
  const { found, entries } = scan(root, false);
  if (found.length > 0) {
    const lines = found.map((link) => `- ${link.path} -> ${link.target}`).join("\n");
    throw new Error(
      `The packaged runtime still contains ${found.length} link(s) under ${root}:\n${lines}\n` +
        "electron-builder follows directory links when it walks the app, so packaging cannot continue."
    );
  }
  console.log(`Verified ${entries} entries under ${root}: no links`);
}

console.log(`Detached ${total} link(s); the package runtime is self-contained`);
