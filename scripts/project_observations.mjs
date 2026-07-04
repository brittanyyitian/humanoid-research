import { projectObservations } from "./services/observation-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/project_observations.mjs

Options:
  --dry-run  Print projection audit without writing files
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const { run } = await projectObservations({ dryRun: Boolean(args.dryRun) });
  if (args.dryRun) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    console.log(
      `Observation projection ${run.id}: ${run.status}. projected=${run.projectedCount}, excludedClaims=${run.excludedClaimCount}, violations=${run.violationCount}`
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      result.help = true;
    } else if (item === "--dry-run") {
      result.dryRun = true;
    }
  }
  return result;
}
