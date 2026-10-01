#!/usr/bin/env node
"use strict";

/**
 * Temporary diagnostic: describe the tree electron-builder walks.
 *
 * The CI Windows packaging job stalls inside electron-builder's app-file walk
 * (computeFileSets) and prints nothing for the whole of it, so there is no
 * way to see which path it is stuck on. This prints the shape of that tree
 * instead — entry counts, depth, and every symlink/junction with its target.
 *
 * The walk descends through directory links, so a link that resolves back
 * into one of its own ancestors (which is what npm workspace links look like)
 * makes it recurse forever: every path it enumerates gets longer, nothing is
 * ever written, and no output is produced. That is one of the shapes this
 * report is looking for.
 *
 * Usage: node diagnose-app-tree.cjs <dir> [--max-entries <n>]
 *
 * Bounded on purpose: the scan never follows a reparse point, and it stops
 * after --max-entries (default 500000) so it cannot fail the way the walk it
 * describes does.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_LINKS_PRINTED = 100;

function parseArgs(argv) {
  const args = { dir: null, maxEntries: 500000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-entries") {
      args.maxEntries = Number(argv[++i]);
    } else if (args.dir == null) {
      args.dir = argv[i];
    }
  }
  return args;
}

const { dir, maxEntries } = parseArgs(process.argv.slice(2));
if (dir == null) {
  console.error("usage: node diagnose-app-tree.cjs <dir> [--max-entries <n>]");
  process.exit(2);
}

const root = path.resolve(dir);
const realRoot = fs.realpathSync(root);

let files = 0;
let directories = 0;
let links = 0;
let truncated = false;
let maxDepth = 0;
let longestPath = "";
const perTop = new Map();
const linkList = [];
const rootEntries = new Set();

// Iterative scan: lstat every child, descend into real directories only.
const queue = [{ dir: root, depth: 0 }];
let visited = 0;
while (queue.length > 0) {
  const { dir: current, depth } = queue.pop();
  let names;
  try {
    names = fs.readdirSync(current);
  } catch (error) {
    console.log(`! unreadable: ${current} (${error.code || error.message})`);
    continue;
  }
  for (const name of names) {
    if (++visited > maxEntries) {
      truncated = true;
      queue.length = 0;
      break;
    }
    const full = path.join(current, name);
    if (depth === 0) {
      rootEntries.add(name);
    }
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch (error) {
      console.log(`! unstatable: ${full} (${error.code || error.message})`);
      continue;
    }
    const top = depth === 0 ? name : full.slice(root.length + 1).split(path.sep)[0];
    if (stat.isSymbolicLink()) {
      links++;
      perTop.set(top, (perTop.get(top) || 0) + 1);
      linkList.push(describeLink(full));
      continue;
    }
    if (stat.isDirectory()) {
      directories++;
      if (depth + 1 > maxDepth) {
        maxDepth = depth + 1;
      }
      queue.push({ dir: full, depth: depth + 1 });
    } else {
      files++;
      perTop.set(top, (perTop.get(top) || 0) + 1);
      if (full.length > longestPath.length) {
        longestPath = full;
      }
    }
  }
}

function describeLink(linkPath) {
  const entry = { path: linkPath, target: null, resolved: null, targetKind: "missing", cycle: false, insideRoot: null };
  try {
    entry.target = fs.readlinkSync(linkPath);
  } catch (error) {
    entry.target = `<unreadable: ${error.code || error.message}>`;
  }
  try {
    entry.resolved = fs.realpathSync(linkPath);
  } catch (error) {
    entry.targetKind = `broken (${error.code || error.message})`;
    return entry;
  }
  // Does the walk, having descended through this link, arrive back at the
  // directory that contains the link? Then it never terminates.
  try {
    const parentReal = fs.realpathSync(path.dirname(linkPath));
    const relative = path.relative(entry.resolved, parentReal);
    entry.cycle = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    // parent unreadable: leave cycle false, the rest of the report still helps
  }
  const relativeToRoot = path.relative(realRoot, entry.resolved);
  entry.insideRoot = relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot));
  try {
    const targetStat = fs.statSync(linkPath);
    entry.targetKind = targetStat.isDirectory() ? "dir" : targetStat.isFile() ? "file" : "other";
  } catch (error) {
    entry.targetKind = `broken (${error.code || error.message})`;
  }
  return entry;
}

const report = [];
report.push(`app tree: ${root}`);
report.push(`  files=${files} dirs=${directories} links=${links} maxDepth=${maxDepth}${truncated ? ` TRUNCATED at ${maxEntries} entries` : ""}`);
report.push(`  longestPath=${longestPath.length} chars: ${longestPath}`);
const breakdown = [...perTop].sort((a, b) => b[1] - a[1]).slice(0, 15);
report.push(`  by top-level entry (entries): ${breakdown.map(([name, count]) => `${name}=${count}`).join(" ")}`);
report.push(`  top-level entries: ${[...rootEntries].sort().join(" ")}`);
report.push(`  links (${linkList.length}), cycles first:`);
for (const link of linkList.sort((a, b) => Number(b.cycle) - Number(a.cycle)).slice(0, MAX_LINKS_PRINTED)) {
  report.push(
    `    ${link.cycle ? "CYCLE " : "      "}${link.path} -> ${link.target}` +
      ` [resolved=${link.resolved} kind=${link.targetKind} insideRoot=${link.insideRoot}]`
  );
}
if (linkList.length > MAX_LINKS_PRINTED) {
  report.push(`    ... ${linkList.length - MAX_LINKS_PRINTED} more links not printed`);
}
console.log(report.join("\n"));
