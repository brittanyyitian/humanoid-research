import path from "node:path";
import { DATA_DIR, readJsonDir, readJsonFile } from "./data-utils.mjs";
import {
  loadRouterContext,
  readExistingRoutes,
  routeArtifact,
  writeRouteDecision,
} from "./services/router-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/route_artifact.mjs --artifact-id <raw_id>
  node scripts/route_artifact.mjs --all

Options:
  --dry-run    Print route decision(s) without writing files
  --force      Rewrite an existing route decision
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

if (!args.artifactId && !args.all) {
  console.error("Missing --artifact-id or --all");
  console.error(usage());
  process.exit(1);
}

const context = await loadRouterContext();
const artifacts = args.all
  ? (await readJsonDir("raw_artifacts")).map((row) => row.data)
  : [await readJsonFile(path.join(DATA_DIR, "raw_artifacts", `${args.artifactId}.json`))];
const routeByArtifactId = await readExistingRoutes();

const decisions = [];
for (const artifact of artifacts) {
  const existing = routeByArtifactId.get(artifact.id);
  if (existing && !args.force) {
    decisions.push(existing);
    continue;
  }
  decisions.push(routeArtifact(artifact, context));
}

if (args.dryRun) {
  console.log(JSON.stringify(decisions, null, 2));
  process.exit(0);
}

for (const decision of decisions) {
  await writeRouteDecision(decision);
}

console.log(`Routed ${decisions.length} artifact(s).`);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      result.help = true;
    } else if (item === "--dry-run") {
      result.dryRun = true;
    } else if (item === "--all") {
      result.all = true;
    } else if (item === "--force") {
      result.force = true;
    } else if (item.startsWith("--")) {
      const key = item
        .slice(2)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}
