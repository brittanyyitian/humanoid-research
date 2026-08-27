import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";
import { hash, nowShanghai } from "./services/router-service.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_SERENITY_HOME = path.join(ROOT, "vendor", "serenity-chan");
const DEFAULT_PYTHON =
  "/Users/edy/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/run_serenity_provider.mjs --all
  node scripts/run_serenity_provider.mjs --entity-id <entity_id>

Options:
  --limit <n>       Limit selected listed entities
  --dry-run         Print selected rows without calling Serenity
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const result = await runProvider({
    all: Boolean(args.all),
    entityId: args.entityId,
    limit: Number.parseInt(args.limit || "", 10),
    dryRun: Boolean(args.dryRun),
  });
  console.log(
    `Serenity provider complete. selected=${result.selectedCount}, written=${result.writtenCount}, failed=${result.failedCount}, skipped=${result.skippedCount}`
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function runProvider(options) {
  if (!options.all && !options.entityId) {
    throw new Error(`Missing --all or --entity-id\n${usage()}`);
  }
  const dashboard = await readJsonFile(path.join(DATA_DIR, "dashboard", "serenity_analysis.json"));
  const rows = selectRows(dashboard.rows || [], options);
  if (options.dryRun) {
    console.log(JSON.stringify(rows.map((row) => ({ entityId: row.entityId, name: row.name, ticker: tickerForRow(row) })), null, 2));
    return {
      selectedCount: rows.length,
      writtenCount: 0,
      failedCount: 0,
      skippedCount: (dashboard.rows || []).length - rows.length,
    };
  }

  let writtenCount = 0;
  let failedCount = 0;
  for (const row of rows) {
    const result = await runOne(row);
    if (result.status === "written") writtenCount += 1;
    if (result.status === "failed") failedCount += 1;
  }
  return {
    selectedCount: rows.length,
    writtenCount,
    failedCount,
    skippedCount: (dashboard.rows || []).length - rows.length,
  };
}

function selectRows(rows, options) {
  let selected = rows.filter((row) => tickerForRow(row));
  if (options.entityId) selected = selected.filter((row) => row.entityId === options.entityId);
  selected = selected.sort(
    (a, b) =>
      (b.inputPack?.materialCounts?.readable || 0) - (a.inputPack?.materialCounts?.readable || 0) ||
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN")
  );
  if (Number.isFinite(options.limit) && options.limit > 0) selected = selected.slice(0, options.limit);
  return selected;
}

async function runOne(row) {
  const generatedAt = nowShanghai();
  const ticker = tickerForRow(row);
  const symbol = symbolForSerenity(ticker);
  const runDir = path.join(DATA_DIR, "serenity_provider", "runs", `${dateSlug(generatedAt)}_${row.entityId}`);
  const command = [
    "scripts/serenity.py",
    "ask",
    `${row.name} 数据面怎么样`,
    "--symbols",
    symbol,
    "--out-dir",
    runDir,
  ];
  const provider = providerInfo({ command, runDir });

  try {
    const execution = await execSerenity(command);
    const output = await buildProviderOutput(row, {
      generatedAt,
      ticker,
      symbol,
      runDir,
      provider: {
        ...provider,
        exitCode: execution.exitCode,
        stdoutTail: tail(execution.stdout),
        stderrTail: tail(execution.stderr),
      },
    });
    await writeJsonFile(path.join(DATA_DIR, "analysis", "serenity_audits", `${row.entityId}.json`), output);
    return { status: "written", output };
  } catch (error) {
    const output = buildFailedOutput(row, {
      generatedAt,
      ticker,
      symbol,
      runDir,
      provider: {
        ...provider,
        exitCode: error.exitCode ?? 1,
        stdoutTail: tail(error.stdout || ""),
        stderrTail: tail(error.stderr || error.message || ""),
      },
      error,
    });
    await writeJsonFile(path.join(DATA_DIR, "analysis", "serenity_audits", `${row.entityId}.json`), output);
    return { status: "failed", output };
  }
}

function execSerenity(command) {
  const serenityHome = process.env.SERENITY_HOME || DEFAULT_SERENITY_HOME;
  const python = process.env.SERENITY_PYTHON || DEFAULT_PYTHON;
  const env = {
    ...process.env,
    SERENITY_DATA_DIR: process.env.SERENITY_DATA_DIR || path.join(DATA_DIR, "serenity_provider"),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(python, command, {
      cwd: serenityHome,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ exitCode, stdout, stderr });
      else reject(Object.assign(new Error(`Serenity exited with ${exitCode}`), { exitCode, stdout, stderr }));
    });
  });
}

async function buildProviderOutput(row, context) {
  const manifestPath = await findManifestPath(context.runDir, context.symbol);
  const manifest = manifestPath ? await readJsonFile(manifestPath) : null;
  const briefPath = path.join(context.runDir, "research_brief.md");
  const brief = await readTextIfExists(briefPath);
  const datasets = manifest?.data_acquisition?.status_by_dataset || {};
  const gaps = ensureArray(manifest?.data_acquisition?.data_gaps);
  const manualTasks = ensureArray(manifest?.data_acquisition?.manual_retrieval_tasks);
  const okCount = Object.values(datasets).filter((status) => status === "OK").length;
  const totalCount = Object.keys(datasets).length;
  const fullReady = Boolean(manifest?.data_acquisition?.full_research_ready);
  const currentFocus =
    totalCount > 0
      ? `Serenity 已完成 ${okCount}/${totalCount} 个数据集取数，${gaps.length ? `仍有 ${gaps.length} 个数据缺口` : "当前无数据缺口"}。`
      : "Serenity 已运行，但未生成可解析的数据集状态。";

  return {
    id: `saout_${row.entityId}_${hash(`${context.symbol}|${context.generatedAt}|${okCount}|${gaps.length}`, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt: context.generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "serenity_data_audit",
    provider: context.provider,
    sourceInputPack: {
      contractType: row.contractType,
      analysisStatus: row.analysisStatus,
      ticker: context.ticker,
      symbol: context.symbol,
    },
    inputRefs: {
      materialRawArtifactIds: (row.inputPack?.topMaterialRefs || []).map((material) => material.rawArtifactId).filter(Boolean),
      claimIds: row.inputPack?.candidateLayer?.claimIds || [],
      evidenceIds: [],
      sourceIds: [],
      providerRunDir: context.runDir,
      manifestPath,
      briefPath,
      dashboardRefs: ["dashboard/serenity_analysis.json"],
    },
    display: {
      mode: "serenity_data_audit",
      label: "Serenity 数据审计",
      title: `${row.name} Serenity 数据审计`,
      summary: currentFocus,
      currentFocus,
      toVerify: auditVerificationItems(gaps, manualTasks),
      viewLabel: "Serenity 数据审计",
      view: fullReady
        ? "数据审计通过，可进入正式研究；这仍不是投资结论。"
        : "数据审计存在缺口，应先补齐取数或人工复核，再进入正式研究。",
      followup: "需要正式分析时，进入 Serenity formal dossier 工作流。",
      materialLine: manifestPath ? `manifest: ${path.basename(manifestPath)}` : "未找到 manifest",
      inputState: `${okCount}/${totalCount || 0} 数据集 OK`,
    },
    layers: {
      factNotes: datasetNotes(datasets),
      candidateSignals: [],
      analysisNotes: [
        {
          label: "数据审计边界",
          text: "Serenity quick route 只输出取数与校验事实；正式 AI 深研需要 formal dossier 工作流。",
          refs: { providerRunDir: context.runDir },
        },
      ],
      evidenceGaps: gaps.map((gap) => ({
        text: gap.next_action || gap.gap_type || gap.dataset || "待补数据",
        status: "open",
      })),
      nextVerificationQuestions: auditVerificationItems(gaps, manualTasks).map((question) => ({
        question,
        status: "open",
      })),
      marketContext: {},
      forecastCandidates: [],
    },
    rawArtifacts: {
      researchBriefExcerpt: brief.slice(0, 4000),
    },
    calibration: {
      status: "not_started",
      note: "数据审计不生成预测账本。",
    },
    guardrails: [
      "Serenity 数据审计不是正式研究结论。",
      "不输出买卖建议。",
      "不把市场涨跌解释为事件影响。",
    ],
  };
}

function buildFailedOutput(row, context) {
  return {
    id: `saout_${row.entityId}_${hash(`${context.symbol}|${context.generatedAt}|failed`, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt: context.generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "serenity_provider_failed",
    provider: context.provider,
    sourceInputPack: {
      contractType: row.contractType,
      analysisStatus: row.analysisStatus,
      ticker: context.ticker,
      symbol: context.symbol,
    },
    inputRefs: {
      providerRunDir: context.runDir,
      dashboardRefs: ["dashboard/serenity_analysis.json"],
    },
    display: {
      mode: "serenity_provider_failed",
      label: "Serenity 取数失败",
      title: `${row.name} Serenity 取数失败`,
      summary: "Serenity 本体已调用，但 provider 未完成取数。",
      currentFocus: "Serenity 本体已调用，但 provider 未完成取数。",
      toVerify: ["检查网络或数据源", "查看 provider stderr", "必要时重跑"],
      viewLabel: "失败原因",
      view: context.provider.stderrTail || context.provider.stdoutTail || context.error?.message || "未知错误",
      followup: "修复后重新运行 serenity:provider。",
      materialLine: "provider failed",
      inputState: "failed",
    },
    layers: {
      factNotes: [],
      candidateSignals: [],
      analysisNotes: [],
      evidenceGaps: [{ text: context.provider.stderrTail || "provider failed", status: "open" }],
      nextVerificationQuestions: [{ question: "检查网络或数据源", status: "open" }],
      marketContext: {},
      forecastCandidates: [],
    },
    calibration: { status: "not_started" },
    guardrails: ["失败输出不构成研究结论。"],
  };
}

function providerInfo({ command, runDir }) {
  return {
    name: "serenity_chan_cli_v0",
    type: "vendored_cli",
    externalCall: true,
    serenityHome: process.env.SERENITY_HOME || DEFAULT_SERENITY_HOME,
    python: process.env.SERENITY_PYTHON || DEFAULT_PYTHON,
    command,
    runDir,
    note: "调用 vendored Serenity Chan CLI 获取公开数据审计结果。",
  };
}

async function findManifestPath(runDir, symbol) {
  const code = String(symbol || "").split(".")[0];
  const direct = path.join(runDir, "data", code, "manifest.json");
  if (await exists(direct)) return direct;
  const dataDir = path.join(runDir, "data");
  try {
    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(dataDir, entry.name, "manifest.json");
      if (await exists(candidate)) return candidate;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

function tickerForRow(row) {
  const ticker = row.profile?.ticker || row.inputPack?.factInputs?.profile?.ticker;
  if (!ticker || ticker === "--" || ticker === "未上市") return null;
  return ticker;
}

function symbolForSerenity(ticker) {
  const text = String(ticker || "").trim();
  if (/^\d{6}\.(SH|SZ)$/i.test(text)) return text.slice(0, 6);
  if (/^\d{5}\.HK$/i.test(text)) return text;
  return text;
}

function auditVerificationItems(gaps, tasks) {
  if (!gaps.length && !tasks.length) return ["可进入正式研究"];
  return [
    ...tasks.map((task) => task.objective || task.dataset || task.target_source),
    ...gaps.map((gap) => gap.next_action || gap.dataset || gap.gap_type),
  ]
    .filter(Boolean)
    .slice(0, 3);
}

function datasetNotes(datasets) {
  return Object.entries(datasets).map(([dataset, status]) => ({
    label: dataset,
    text: `${dataset}: ${status}`,
    refs: {},
  }));
}

async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function tail(text, length = 2000) {
  return String(text || "").slice(-length);
}

function dateSlug(value) {
  return String(value || nowShanghai()).slice(0, 19).replace(/[-:T]/g, "_");
}

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
