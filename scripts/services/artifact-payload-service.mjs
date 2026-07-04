import crypto from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../data-utils.mjs";

export function rawPayloadStoragePath(artifactId) {
  return `raw_artifacts/payloads/${artifactId}.json`;
}

export function rawPayloadFilePath(artifactId) {
  return path.join(DATA_DIR, rawPayloadStoragePath(artifactId));
}

export function buildRawPayload({
  artifactId,
  inputType,
  url,
  title,
  publisher,
  publishedAt = null,
  capturedAt,
  sourceType,
  artifactType,
  entityIds = [],
  body = null,
  bodyFormat = null,
}) {
  const hasBody = typeof body === "string" && body.trim() !== "";
  return {
    id: artifactId,
    capturedAt,
    retrievalStatus: hasBody ? "captured_payload" : "metadata_only",
    content: {
      inputType,
      url,
      title,
      publisher,
      publishedAt,
      sourceType,
      artifactType,
      entityIds,
      body: hasBody ? body : null,
      bodyFormat: hasBody ? bodyFormat || "text" : null,
    },
  };
}

export function contentHashForPayload(rawPayload) {
  return `sha256:${sha256(stableStringify(rawPayload.content))}`;
}

export function fetchStatusForPayload(inputType, rawPayload) {
  if (inputType === "manual") return "manual";
  return rawPayload.retrievalStatus === "captured_payload" ? "success" : "partial";
}

export function gapsForPayload(rawPayload) {
  if (rawPayload.retrievalStatus === "captured_payload") return [];
  return [
    {
      kind: "raw_payload_not_fetched",
      description: "Ingestion captured source metadata only; raw body retrieval is not enabled for this source yet.",
      severity: "medium",
    },
  ];
}

export function attemptLedgerForPayload({ inputType, url, capturedAt, rawPayload, contentHash, storagePath }) {
  return [
    {
      kind: "source_capture",
      inputType,
      url,
      status: rawPayload.retrievalStatus,
      startedAt: capturedAt,
      finishedAt: capturedAt,
      contentHash,
      storagePath,
    },
  ];
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
