import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check") || process.env.MEMMY_VERSION_SYNC_CHECK_ONLY === "1";
const rootManifestPath = join(root, "package.json");
const rootManifest = await readJson(rootManifestPath);
const version = rootManifest.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid project version in ${rootManifestPath}`);
}

const derivedManifests = [
  "App/memmy-agent/package.json",
  "App/shell/desktop/package.json",
];

const staleFiles = [];
for (const relativePath of derivedManifests) {
  await updateJson(relativePath, (json) => {
    json.version = version;
  });
}

await updateText(
  "App/backend/src/project-version.ts",
  `/** Generated from the root package.json by scripts/sync-project-version.mjs. */\nexport const MEMMY_VERSION = ${JSON.stringify(version)};\n`
);

await updateJson("package-lock.json", (json) => {
  json.version = version;
  json.packages[""].version = version;
  json.packages["App/shell/desktop"].version = version;
});

await updateJson("App/memmy-agent/package-lock.json", (json) => {
  json.version = version;
  json.packages[""].version = version;
});

if (staleFiles.length > 0) {
  throw new Error(`Derived version metadata is stale: ${staleFiles.join(", ")}`);
}

console.log(`${checkOnly ? "Verified" : "Synchronized"} project version ${version}`);

async function updateJson(relativePath, update) {
  const absolutePath = join(root, relativePath);
  const currentText = await readFile(absolutePath, "utf8");
  const json = JSON.parse(currentText);
  update(json);
  const nextText = `${JSON.stringify(json, null, 2)}\n`;
  if (matchesIgnoringLineEndings(nextText, currentText)) return;
  if (checkOnly) {
    staleFiles.push(relativePath);
    return;
  }
  await writeFile(absolutePath, nextText, "utf8");
}

async function updateText(relativePath, nextText) {
  const absolutePath = join(root, relativePath);
  const currentText = await readFile(absolutePath, "utf8");
  if (matchesIgnoringLineEndings(nextText, currentText)) return;
  if (checkOnly) {
    staleFiles.push(relativePath);
    return;
  }
  await writeFile(absolutePath, nextText, "utf8");
}

/**
 * Compares file text while ignoring line-ending style.
 *
 * Git for Windows checks out CRLF by default, and a CRLF working tree carries
 * byte-identical metadata — reporting it as stale fails the build for a reason
 * that has nothing to do with versions, which is how the Windows packaging
 * path broke. Line endings are not version metadata, so they do not decide
 * staleness; a file that differs only in EOL style is left untouched.
 *
 * @param expected the text this script would write.
 * @param actual the text currently on disk.
 * @returns whether the two carry the same content.
 */
function matchesIgnoringLineEndings(expected, actual) {
  return expected === actual || expected === actual.replace(/\r\n/g, "\n");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
