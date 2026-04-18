import { getInput, setOutput, setFailed, info, warning } from "@actions/core";
import { context } from "@actions/github";
import { buildReportJson, discoverAssets } from "./collector";
import { fullUpload } from "./uploader";
import type { UploadConfig } from "./types";

function getEnv(name: string): string | undefined {
  return process.env[name];
}

function isGitHubActions(): boolean {
  return !!getEnv("GITHUB_ACTIONS");
}

function buildConfig(): UploadConfig {
  const apiKey = getInput("api-key", { required: true });
  const endpoint = getInput("endpoint") || "https://testify.codes";

  let prNumber = getInput("pr-number") || undefined;
  let prTitle = getInput("pr-title") || undefined;
  let branch = getInput("branch") || undefined;
  let commitSha = getInput("commit-sha") || undefined;

  if (isGitHubActions()) {
    const ctx = context;
    const ref = ctx.ref;

    if (!commitSha) commitSha = ctx.sha;
    if (!branch) branch = ref.replace(/^refs\/heads\//, "");

    if (ctx.eventName === "pull_request" || ctx.eventName === "pull_request_target") {
      const pr = (ctx.payload as { pull_request?: { number: number; title?: string } }).pull_request;
      if (pr) {
        if (!prNumber) prNumber = String(pr.number);
        if (!prTitle) prTitle = pr.title;
      }
    }

    if (!commitSha) commitSha = getEnv("GITHUB_SHA");
    if (!branch) branch = getEnv("GITHUB_REF_NAME");
  }

  const ciProvider = getEnv("GITHUB_ACTIONS")
    ? "gh_actions"
    : getEnv("GITLAB_CI")
      ? "gitlab_ci"
      : "other";

  const ciRunId = getEnv("GITHUB_RUN_ID") || getEnv("CI_PIPELINE_ID");

  return {
    apiKey,
    endpoint: endpoint.replace(/\/$/, ""),
    prNumber,
    prTitle,
    branch,
    commitSha,
    ciProvider,
    ciRunId,
    playwrightReport: getInput("playwright-report") || undefined,
    vitestReport: getInput("vitest-report") || undefined,
    coverageReport: getInput("coverage-report") || undefined,
    reportJson: getInput("report-json") || undefined,
    assetsDir: getInput("assets-dir") || undefined,
  };
}

async function run(): Promise<void> {
  try {
    const config = buildConfig();

    info(`Testify endpoint: ${config.endpoint}`);
    info(`Branch: ${config.branch || "(none)"}`);
    info(`Commit: ${config.commitSha || "(none)"}`);
    info(`PR: ${config.prNumber ? `#${config.prNumber} ${config.prTitle || ""}` : "(none)"}`);

    info("Collecting test results...");
    const { report: reportJson, pwAssets } = buildReportJson({
      playwrightPath: config.playwrightReport,
      vitestPath: config.vitestReport,
      coveragePath: config.coverageReport,
      prebuiltPath: config.reportJson,
    });

    const d = reportJson.dashboard;
    info(
      `Results: ${d.testCases} tests, ${d.passed} passed, ${d.failed} failed, ${d.skipped} skipped`,
    );
    if (d.coverage) {
      info(`Coverage: ${d.coverage.lines.pct}% lines`);
    }

    const fsAssets = config.assetsDir ? await discoverAssets(config.assetsDir) : [];
    const allAssets = [...fsAssets, ...pwAssets];
    info(`Assets to upload: ${allAssets.length} (${pwAssets.length} from pw-data)`);

    const reportId = await fullUpload(config, reportJson, allAssets);

    setOutput("report-id", reportId);
    setOutput(
      "report-url",
      `${config.endpoint}/reports/${reportId}`,
    );

    info(`Report uploaded: ${reportId}`);

    if (d.failed > 0) {
      warning(`${d.failed} test(s) failed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setFailed(`Testify upload failed: ${message}`);
  }
}

export { run, buildConfig };

run();
