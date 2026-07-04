import { runHardeningChecks } from "./services/hardening-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/hardening_check.mjs

Options:
  --json             Print full audit JSON
  --strict-warnings  Treat warnings as failures
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

const audit = await runHardeningChecks();
const failed = audit.errors.length > 0 || (args.strictWarnings && audit.warnings.length > 0);

if (args.json) {
  console.log(JSON.stringify(audit, null, 2));
} else {
  console.log(`Hardening ${audit.status}. checks=${audit.summary.checks}, errors=${audit.summary.errors}, warnings=${audit.summary.warnings}`);
  for (const check of audit.checks) {
    const marker = check.status === "passed" ? "PASS" : "FAIL";
    console.log(`${marker} ${check.id}`);
    for (const error of check.errors) console.log(`  error: ${error}`);
    for (const warning of check.warnings) console.log(`  warning: ${warning}`);
  }
}

if (failed) process.exit(1);

function parseArgs(argv) {
  const result = {};
  for (const item of argv) {
    if (item === "--help" || item === "-h") result.help = true;
    if (item === "--json") result.json = true;
    if (item === "--strict-warnings") result.strictWarnings = true;
  }
  return result;
}
