import fs from "fs";
import { type UploadConfig, type InitResponse, type AssetDeclaration, type ReportJson } from "./types";

async function request(
  url: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
  maxRedirects = 5,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const response = await fetch(currentUrl, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect ${response.status} without Location header`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      console.log(`[testify] Redirect ${response.status} -> ${currentUrl}`);
      continue;
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return { ok: response.ok, status: response.status, data };
  }

  throw new Error(`Too many redirects (>${maxRedirects})`);
}

export async function initUpload(config: UploadConfig): Promise<InitResponse> {
  const url = `${config.endpoint}/api/v1/reports/init`;

  const body: Record<string, unknown> = {
    ci_provider: config.ciProvider || "gh_actions",
  };

  if (config.prNumber) body.pr_number = parseInt(config.prNumber, 10);
  if (config.prTitle) body.pr_title = config.prTitle;
  if (config.branch) body.branch = config.branch;
  if (config.commitSha) body.commit_sha = config.commitSha;
  if (config.ciRunId) body.ci_run_id = config.ciRunId;

  console.log(`[testify] Initializing upload to ${url}`);

  const result = await request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!result.ok) {
    throw new Error(`Init failed (${result.status}): ${JSON.stringify(result.data)}`);
  }

  return result.data as InitResponse;
}

export async function initUploadWithAssets(
  config: UploadConfig,
  assets: AssetDeclaration[],
): Promise<InitResponse> {
  const url = `${config.endpoint}/api/v1/reports/init`;

  const body: Record<string, unknown> = {
    ci_provider: config.ciProvider || "gh_actions",
    assets,
  };

  if (config.prNumber) body.pr_number = parseInt(config.prNumber, 10);
  if (config.prTitle) body.pr_title = config.prTitle;
  if (config.branch) body.branch = config.branch;
  if (config.commitSha) body.commit_sha = config.commitSha;
  if (config.ciRunId) body.ci_run_id = config.ciRunId;

  console.log(`[testify] Initializing upload with ${assets.length} assets`);

  const result = await request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!result.ok) {
    throw new Error(`Init failed (${result.status}): ${JSON.stringify(result.data)}`);
  }

  return result.data as InitResponse;
}

export async function uploadToPresignedUrl(
  presignedUrl: string,
  filePath: string,
  contentType: string = "application/octet-stream",
): Promise<void> {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = filePath.split("/").pop() || "file";

  console.log(`[testify] Uploading ${fileName} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);

  const response = await fetch(presignedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": fileBuffer.length.toString(),
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    throw new Error(`Upload failed for ${fileName}: ${response.status} ${await response.text()}`);
  }

  console.log(`[testify] Uploaded ${fileName}`);
}

export async function uploadReportJson(
  presignedUrl: string,
  report: ReportJson,
): Promise<void> {
  const body = JSON.stringify(report);
  console.log(`[testify] Uploading report.json (${(body.length / 1024).toFixed(1)} KB)`);

  const response = await fetch(presignedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body).toString(),
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Report upload failed: ${response.status} ${await response.text()}`);
  }

  console.log("[testify] Uploaded report.json");
}

export async function finalizeUpload(
  config: UploadConfig,
  reportId: string,
): Promise<{ report_id: string; status: string }> {
  const url = `${config.endpoint}/api/v1/reports/${reportId}/finalize`;

  console.log(`[testify] Finalizing report ${reportId}`);

  const result = await request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!result.ok) {
    throw new Error(`Finalize failed (${result.status}): ${JSON.stringify(result.data)}`);
  }

  return result.data as { report_id: string; status: string };
}

export async function fullUpload(
  config: UploadConfig,
  reportJson: ReportJson,
  assets: { name: string; path: string; content_type: string }[],
): Promise<string> {
  console.log("[testify] === Phase 1: Init ===");
  const assetDeclarations: AssetDeclaration[] = assets.map((a) => ({
    name: a.name,
    type: guessAssetType(a.name),
    size: fs.statSync(a.path).size,
    content_type: a.content_type,
  }));

  const init = await initUploadWithAssets(config, assetDeclarations);
  console.log(`[testify] Report ID: ${init.report_id}`);

  console.log("[testify] === Phase 2: Upload ===");
  await uploadReportJson(init.report_upload_url, reportJson);

  const uploadPromises = init.assets.map((asset) => {
    const localAsset = assets.find((a) => a.name === asset.name);
    if (!localAsset) {
      console.warn(`[testify] No local file for asset: ${asset.name}`);
      return Promise.resolve();
    }
    return uploadToPresignedUrl(asset.upload_url, localAsset.path, localAsset.content_type);
  });

  await Promise.all(uploadPromises);

  console.log("[testify] === Phase 3: Finalize ===");
  const finalizeResult = await finalizeUpload(config, init.report_id);
  console.log(`[testify] Report ${finalizeResult.report_id} status: ${finalizeResult.status}`);

  return init.report_id;
}

function guessAssetType(name: string): "screenshot" | "video" | "coverage" {
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "screenshot";
  if (name.endsWith(".webm") || name.endsWith(".mp4")) return "video";
  if (name.endsWith(".json")) return "coverage";
  return "screenshot";
}
