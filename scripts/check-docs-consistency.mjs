import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

export function latestMigrationNumber(fileNames) {
  const numbers = fileNames
    .map((name) => /^(\d{4})_[^/]+\.sql$/u.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  if (!numbers.length) throw new Error("DOCUMENTATION_MIGRATION_CHECKPOINT_MISSING");
  return Math.max(...numbers);
}

function checkpointIn(pattern, source, label) {
  const match = pattern.exec(source);
  if (!match) throw new Error(`DOCUMENTATION_CHECKPOINT_DECLARATION_MISSING:${label}`);
  return Number(match[1]);
}

export function validateDocumentation({ latest, readme, release, schedule }) {
  const expected = String(latest).padStart(4, "0");
  const declarations = [
    ["README", checkpointIn(/(?:candidato local|`main`) contém[\s\S]{0,140}?migration `(\d{4})`/u, readme, "README")],
    ["release", checkpointIn(/checkpoint\s+`(\d{4})`/u, release, "release")],
    ["release-status", checkpointIn(/checkpoint `(\d{4})` está (?:presente no candidato local|integrado à `main`)/u, release, "release-status")],
  ];
  const stale = declarations.filter(([, value]) => value !== latest);
  if (stale.length) throw new Error(`DOCUMENTATION_CHECKPOINT_STALE:expected=${expected}:found=${stale.map(([label, value]) => `${label}=${value}`).join(",")}`);
  const incrementRange = new RegExp("migrations? `0068`[\\s\\S]{0,900}`" + expected + "`", "u");
  if (!incrementRange.test(schedule)) {
    throw new Error(`DOCUMENTATION_INCREMENT_RANGE_MISSING:0068-${expected}`);
  }
  return { latest, declarations: Object.fromEntries(declarations) };
}

export async function readRepositoryDocumentation(root = repositoryRoot) {
  const migrationDirectory = path.join(root, "database", "migrations");
  const names = await fs.readdir(migrationDirectory);
  const latest = latestMigrationNumber(names);
  const read = (relative) => fs.readFile(path.join(root, relative), "utf8");
  const [readme, release, schedule] = await Promise.all([
    read("README.md"), read("docs/release-local.md"), read("docs/cronograma.md"),
  ]);
  return { latest, readme, release, schedule };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = validateDocumentation(await readRepositoryDocumentation());
    console.log(`documentation_consistency=passed checkpoint=${String(result.latest).padStart(4, "0")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "DOCUMENTATION_CONSISTENCY_FAILED");
    process.exitCode = 1;
  }
}
