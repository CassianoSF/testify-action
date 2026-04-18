import fs from "fs";
import path from "path";
import crypto from "crypto";
import { glob } from "glob";
import {
  type ReportJson,
  type TestModule,
  type Feature,
  type FeatureStats,
  type Scenario,
  type TestCase,
  type TestStep,
  type CoverageData,
  type PlaywrightReport,
  type PlaywrightSuite,
  type PlaywrightSpec,
  type VitestFileResult,
  type VitestAssertion,
  type IstanbulCoverage,
  type IntegrationStepRaw,
  type TestStatus,
} from "./types";

export interface ResolvedAsset {
  name: string;
  path: string;
  type: "screenshot" | "video" | "coverage";
  size: number;
  content_type: string;
}

export interface BuildResult {
  report: ReportJson;
  pwAssets: ResolvedAsset[];
}

function extFromContentType(ct: string): string {
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webm")) return "webm";
  if (ct.includes("mp4")) return "mp4";
  return "png";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeStatus(status: string): "passed" | "failed" | "skipped" | "timedOut" | "interrupted" {
  if (status === "passed" || status === "expected") return "passed";
  if (status === "failed" || status === "unexpected") return "failed";
  if (status === "timedOut") return "timedOut";
  if (status === "interrupted") return "interrupted";
  if (status === "skipped" || status === "pending" || status === "todo" || status === "fixme") return "skipped";
  return "skipped";
}

interface ModuleMeta {
  module: string;
  moduleSlug: string;
  feature?: string;
}

const MODULE_PATH_PATTERNS = [
  /(?:src\/)?modules\/([^/]+)\/test\/([^/]+)/,
  /([^/]+)\/test\/([^/]+)\//,
];

function extractModuleFromPath(filePath: string): ModuleMeta | null {
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of MODULE_PATH_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        module: match[1],
        moduleSlug: slugify(match[1]),
        feature: match[2],
      };
    }
  }
  return null;
}

function extractMetaFromTags(tags: string[]): { module?: string; feature?: string } {
  const result: { module?: string; feature?: string } = {};
  for (const tag of tags) {
    if (tag.startsWith("@module:")) {
      result.module = tag.slice("@module:".length);
    } else if (tag.startsWith("@feature:")) {
      result.feature = tag.slice("@feature:".length);
    }
  }
  return result;
}

function resolveModuleMeta(specFile: string | undefined, suiteFile: string | undefined, tags: string[]): ModuleMeta {
  const tagMeta = extractMetaFromTags(tags);
  if (tagMeta.module) {
    return {
      module: tagMeta.module,
      moduleSlug: slugify(tagMeta.module),
      feature: tagMeta.feature,
    };
  }

  const filePath = specFile || suiteFile || "";
  const pathMeta = extractModuleFromPath(filePath);
  if (pathMeta) {
    if (tagMeta.feature) {
      pathMeta.feature = tagMeta.feature;
    }
    return pathMeta;
  }

  const fallbackName = filePath.split("/").pop()?.replace(/\.(spec|test)\.[^.]+$/, "") || "unknown";
  return {
    module: fallbackName,
    moduleSlug: slugify(fallbackName),
  };
}

function extractPwSteps(pwSteps: { title: string; duration: number; status: string; error?: string | { message: string }; steps?: typeof pwSteps; attachments?: { name: string; path: string; contentType: string }[] }[]): TestStep[] {
  const result: TestStep[] = [];
  for (const step of pwSteps) {
    let stepStatus = normalizeStatus(step.status);

    if (stepStatus === "skipped" && step.duration > 0 && step.steps?.length) {
      const childStatuses = step.steps.map((s: { status: string }) => normalizeStatus(s.status));
      if (childStatuses.some((s: string) => s === "failed" || s === "timedOut")) {
        stepStatus = "failed";
      } else {
        stepStatus = "passed";
      }
    } else if (stepStatus === "skipped" && step.duration > 0 && !step.steps?.length) {
      stepStatus = "passed";
    }

    result.push({
      title: step.title,
      status: stepStatus,
      duration: step.duration || 0,
      error: typeof step.error === "object" ? step.error?.message : step.error,
      isBdd: false,
      screenshots: [],
      attachments: (step.attachments || []).map((a) => ({
        name: a.name,
        path: a.path,
        contentType: a.contentType,
      })),
    });
    if (step.steps?.length) {
      result.push(...extractPwSteps(step.steps));
    }
  }
  return result;
}

interface PwSpecData {
  scenario: Scenario;
  e2ePassed: number;
  e2eFailed: number;
  moduleName: string;
  featureSlug: string;
  featureName: string;
}

function collectPwSpecs(
  suite: PlaywrightSuite,
  suiteFile: string,
  dataDir: string | null,
  resolvedFiles: Map<string, ResolvedAsset>,
): PwSpecData[] {
  const results: PwSpecData[] = [];

  for (const spec of suite.specs) {
    const meta = resolveModuleMeta(spec.file, suiteFile, spec.tags);

    const test = spec.tests?.[0];
    const result = test?.results?.[test.results.length - 1];
    const rawStatus = result?.status || test?.status || spec.status || "passed";
    const status = normalizeStatus(rawStatus);
    const specDuration = result?.duration || spec.duration || 0;

    const steps = result?.steps ? extractPwSteps(result.steps) : [];

    const screenshotByName = new Map<string, string>();
    for (const a of result?.attachments || []) {
      if (!a.contentType?.startsWith("image/")) continue;

      if (a.path) {
        screenshotByName.set(a.name?.trim(), a.path);
      } else if (a.body && dataDir) {
        const ext = extFromContentType(a.contentType);
        const hash = crypto.createHash("sha1").update(Buffer.from(a.body, "base64")).digest("hex");
        const filename = `${hash}.${ext}`;
        const fullPath = path.join(dataDir, filename);
        if (fs.existsSync(fullPath)) {
          const assetName = `pw-data/${filename}`;
          if (!resolvedFiles.has(assetName)) {
            const stat = fs.statSync(fullPath);
            resolvedFiles.set(assetName, {
              name: assetName,
              path: fullPath,
              type: "screenshot",
              size: stat.size,
              content_type: a.contentType,
            });
          }
          screenshotByName.set(a.name?.trim(), assetName);
        }
      }
    }

    for (const step of steps) {
      const ss = screenshotByName.get(step.title?.trim());
      if (ss) {
        step.screenshots = [ss];
      }
    }

    const screenshots: string[] = [];
    for (const a of result?.attachments || []) {
      if (!a.contentType?.startsWith("image/")) continue;

      if (a.path) {
        screenshots.push(a.path);
      } else if (a.body && dataDir) {
        const ext = extFromContentType(a.contentType);
        const hash = crypto.createHash("sha1").update(Buffer.from(a.body, "base64")).digest("hex");
        const filename = `${hash}.${ext}`;
        const fullPath = path.join(dataDir, filename);
        if (fs.existsSync(fullPath)) {
          const assetName = `pw-data/${filename}`;
          if (!resolvedFiles.has(assetName)) {
            const stat = fs.statSync(fullPath);
            resolvedFiles.set(assetName, {
              name: assetName,
              path: fullPath,
              type: "screenshot",
              size: stat.size,
              content_type: a.contentType,
            });
          }
          screenshots.push(assetName);
        } else {
          screenshots.push(a.body);
        }
      } else if (a.body) {
        screenshots.push(a.body);
      }
    }

    const video = (result?.attachments || []).find((a) => a.contentType?.startsWith("video/"))?.path;
    const error = typeof result?.error === "object" ? result.error?.message : result?.error;

    const testCase: TestCase = {
      id: `e2e-${spec.title}`,
      title: spec.title,
      status,
      duration: specDuration,
      type: "e2e",
      steps,
      screenshots,
      video,
      error,
      retries: test?.retries || 0,
      attachments: (result?.attachments || []).map((a) => ({
        name: a.name,
        path: a.path,
        contentType: a.contentType,
      })),
    };

    const scenarioSlug = slugify(spec.title);
    const featureSlug = meta.feature ? slugify(meta.feature) : "default";
    const featureName = meta.feature || "Default";
    results.push({
      scenario: {
        id: `${meta.moduleSlug}-${scenarioSlug}`,
        name: spec.title,
        slug: scenarioSlug,
        moduleSlug: meta.moduleSlug,
        featureSlug,
        e2e: testCase,
        integration: null,
        status,
        duration: specDuration,
      },
      e2ePassed: status === "passed" ? 1 : 0,
      e2eFailed: (status === "failed" || status === "timedOut") ? 1 : 0,
      moduleName: meta.module,
      featureSlug,
      featureName,
    });
  }

  if (suite.suites?.length) {
    for (const child of suite.suites) {
      results.push(...collectPwSpecs(child, child.file || suiteFile, dataDir, resolvedFiles));
    }
  }

  return results;
}

function extractPwModules(reportPath: string): {
  modules: TestModule[];
  totalPassed: number;
  totalFailed: number;
  totalSkipped: number;
  totalDuration: number;
  totalTestCases: number;
  pwAssets: ResolvedAsset[];
} {
  if (!fs.existsSync(reportPath)) {
    return { modules: [], totalPassed: 0, totalFailed: 0, totalSkipped: 0, totalDuration: 0, totalTestCases: 0, pwAssets: [] };
  }

  const report: PlaywrightReport = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

  const dataDir = path.join(path.dirname(reportPath), "data");
  const resolvedFiles = new Map<string, ResolvedAsset>();

  const allSpecs: PwSpecData[] = [];
  for (const suite of report.suites) {
    allSpecs.push(...collectPwSpecs(suite, suite.file, fs.existsSync(dataDir) ? dataDir : null, resolvedFiles));
  }

  const moduleMap = new Map<string, { features: Map<string, { scenarios: Scenario[]; passed: number; failed: number; skipped: number; duration: number }>; passed: number; failed: number; duration: number }>();
  const moduleNameMap = new Map<string, string>();
  const featureNameMap = new Map<string, string>();

  for (const specData of allSpecs) {
    const s = specData.scenario;
    if (!moduleNameMap.has(s.moduleSlug) && specData.moduleName) {
      moduleNameMap.set(s.moduleSlug, specData.moduleName);
    }
    const featureKey = `${s.moduleSlug}::${s.featureSlug}`;
    if (!featureNameMap.has(featureKey) && specData.featureName) {
      featureNameMap.set(featureKey, specData.featureName);
    }

    if (!moduleMap.has(s.moduleSlug)) {
      moduleMap.set(s.moduleSlug, { features: new Map(), passed: 0, failed: 0, duration: 0 });
    }
    const mod = moduleMap.get(s.moduleSlug)!;

    if (!mod.features.has(s.featureSlug)) {
      mod.features.set(s.featureSlug, { scenarios: [], passed: 0, failed: 0, skipped: 0, duration: 0 });
    }
    const feat = mod.features.get(s.featureSlug)!;
    feat.scenarios.push(s);
    feat.passed += specData.e2ePassed;
    feat.failed += specData.e2eFailed;
    feat.skipped += s.status === "skipped" ? 1 : 0;
    feat.duration += s.duration;

    mod.passed += specData.e2ePassed;
    mod.failed += specData.e2eFailed;
    mod.duration += s.duration;
  }

  const modules: TestModule[] = [];

  for (const [moduleSlug, modData] of moduleMap) {
    const moduleName = moduleNameMap.get(moduleSlug) || moduleSlug;
    const features: Feature[] = [];

    for (const [featureSlug, featData] of modData.features) {
      const featureKey = `${moduleSlug}::${featureSlug}`;
      const featureName = featureNameMap.get(featureKey) || featureSlug;
      const total = featData.scenarios.length;

      features.push({
        slug: featureSlug,
        name: featureName,
        moduleSlug,
        scenarios: featData.scenarios,
        stats: {
          total,
          passed: featData.passed,
          failed: featData.failed,
          skipped: featData.skipped,
          duration: featData.duration,
          e2e: { total, passed: featData.passed, failed: featData.failed },
          integration: { total: 0, passed: 0, failed: 0 },
        },
      });
    }

    const totalScenarios = features.reduce((sum, f) => sum + f.stats.total, 0);
    const totalPassed = features.reduce((sum, f) => sum + f.stats.passed, 0);
    const totalFailed = features.reduce((sum, f) => sum + f.stats.failed, 0);
    const totalSkipped = features.reduce((sum, f) => sum + f.stats.skipped, 0);

    modules.push({
      slug: moduleSlug,
      name: moduleName,
      features,
      coverage: { merged: null, e2e: null, integration: null },
      stats: {
        total: totalScenarios,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        duration: modData.duration,
        e2e: { total: totalScenarios, passed: totalPassed, failed: totalFailed },
        integration: { total: 0, passed: 0, failed: 0 },
      },
    });
  }

  const totalPassed = modules.reduce((s, m) => s + m.stats.passed, 0);
  const totalFailed = modules.reduce((s, m) => s + m.stats.failed, 0);
  const totalDuration = modules.reduce((s, m) => s + m.stats.duration, 0);
  const totalTestCases = totalPassed + totalFailed;

  return { modules, totalPassed, totalFailed, totalSkipped: 0, totalDuration, totalTestCases, pwAssets: [...resolvedFiles.values()] };
}

function parseIntegrationSteps(
  rawSteps: IntegrationStepRaw[] | undefined,
): TestStep[] {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return [];
  }

  return rawSteps.map((s) => ({
    title: s.title,
    status: normalizeStatus(s.status || "passed") as TestStatus,
    duration: s.duration || 0,
    screenshots: [],
    error: s.error,
    isBdd: true,
    bddKeyword: s.keyword as "DADO" | "QUANDO" | "ENTÃO" | "E",
    attachments: [],
    contractData: s.contract,
    runtimeData: s.runtime,
  }));
}

function extractVitestModules(reportPath: string): {
  modules: TestModule[];
  totalPassed: number;
  totalFailed: number;
  totalSkipped: number;
  totalDuration: number;
  totalTestCases: number;
} {
  if (!fs.existsSync(reportPath)) {
    return { modules: [], totalPassed: 0, totalFailed: 0, totalSkipped: 0, totalDuration: 0, totalTestCases: 0 };
  }

  const raw = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  const testResults: VitestFileResult[] = raw.testResults || raw;

  if (!Array.isArray(testResults)) {
    return { modules: [], totalPassed: 0, totalFailed: 0, totalSkipped: 0, totalDuration: 0, totalTestCases: 0 };
  }

  const moduleMap = new Map<string, Map<string, Scenario[]>>();
  const moduleNameMap = new Map<string, string>();
  const featureNameMap = new Map<string, string>();
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalDuration = 0;

  for (const fileResult of testResults) {
    const filePath = fileResult.name || "unknown";
    const pathMeta = extractModuleFromPath(filePath);

    let moduleSlug: string;
    let moduleName: string;
    let featureSlug: string;
    let featureName: string;

    if (pathMeta) {
      moduleSlug = pathMeta.moduleSlug;
      moduleName = pathMeta.module;
      featureSlug = pathMeta.feature ? slugify(pathMeta.feature) : "default";
      featureName = pathMeta.feature || "Default";
    } else {
      const fileName = filePath.split("/").pop()?.replace(/\.(test|spec)\..*$/, "") || filePath;
      moduleSlug = slugify(fileName);
      moduleName = fileName;
      featureSlug = "default";
      featureName = "Default";
    }

    if (!moduleMap.has(moduleSlug)) {
      moduleMap.set(moduleSlug, new Map());
      moduleNameMap.set(moduleSlug, moduleName);
    }

    const featureKey = `${moduleSlug}::${featureSlug}`;
    if (!featureNameMap.has(featureKey)) {
      featureNameMap.set(featureKey, featureName);
    }

    const modFeatures = moduleMap.get(moduleSlug)!;
    if (!modFeatures.has(featureSlug)) {
      modFeatures.set(featureSlug, []);
    }

    const assertions = fileResult.assertionResults || [];
    for (const assertion of assertions) {
      const status = normalizeStatus(assertion.status || "passed");
      const duration = assertion.duration || 0;
      totalDuration += duration;

      if (status === "passed") totalPassed++;
      else if (status === "failed") totalFailed++;
      else totalSkipped++;

      const steps = parseIntegrationSteps(assertion.meta?.integrationSteps);

      const testCase: TestCase = {
        id: `int-${assertion.fullName || assertion.title}`,
        title: assertion.title || assertion.fullName || "unknown",
        status,
        duration,
        type: "integration",
        steps,
        screenshots: [],
        error: assertion.failureMessages?.join("\n") || undefined,
        retries: 0,
        attachments: [],
      };

      const scenarioSlug = slugify(assertion.title || assertion.fullName || "unknown");
      const scenario: Scenario = {
        id: `${moduleSlug}-${scenarioSlug}`,
        name: assertion.fullName || assertion.title || "unknown",
        slug: scenarioSlug,
        moduleSlug,
        featureSlug,
        e2e: null,
        integration: testCase,
        status,
        duration,
      };

      modFeatures.get(featureSlug)!.push(scenario);
    }
  }

  const modules: TestModule[] = [];
  for (const [moduleSlug, modFeatures] of moduleMap) {
    const features: Feature[] = [];

    for (const [featureSlug, scenarios] of modFeatures) {
      const featureKey = `${moduleSlug}::${featureSlug}`;
      const displayName = featureNameMap.get(featureKey) || featureSlug;
      const total = scenarios.length;
      const passed = scenarios.filter((s) => s.status === "passed").length;
      const failed = scenarios.filter((s) => s.status === "failed").length;
      const skipped = scenarios.filter((s) => s.status === "skipped").length;
      const duration = scenarios.reduce((sum, s) => sum + s.duration, 0);

      features.push({
        slug: featureSlug,
        name: displayName,
        moduleSlug,
        scenarios,
        stats: {
          total,
          passed,
          failed,
          skipped,
          duration,
          e2e: { total: 0, passed: 0, failed: 0 },
          integration: { total, passed, failed },
        },
      });
    }

    const totalScenarios = features.reduce((sum, f) => sum + f.stats.total, 0);
    const passedScenarios = features.reduce((sum, f) => sum + f.stats.passed, 0);
    const failedScenarios = features.reduce((sum, f) => sum + f.stats.failed, 0);
    const skippedScenarios = features.reduce((sum, f) => sum + f.stats.skipped, 0);
    const durationScenarios = features.reduce((sum, f) => sum + f.stats.duration, 0);

    const displayName = moduleNameMap.get(moduleSlug) || moduleSlug;
    modules.push({
      slug: moduleSlug,
      name: displayName,
      features,
      coverage: { merged: null, e2e: null, integration: null },
      stats: {
        total: totalScenarios,
        passed: passedScenarios,
        failed: failedScenarios,
        skipped: skippedScenarios,
        duration: durationScenarios,
        e2e: { total: 0, passed: 0, failed: 0 },
        integration: { total: totalScenarios, passed: passedScenarios, failed: failedScenarios },
      },
    });
  }

  return {
    modules,
    totalPassed,
    totalFailed,
    totalSkipped,
    totalDuration,
    totalTestCases: totalPassed + totalFailed + totalSkipped,
  };
}

export function collectCoverage(coveragePath: string): CoverageData | null {
  if (!coveragePath || !fs.existsSync(coveragePath)) {
    return null;
  }

  const coverage: IstanbulCoverage = JSON.parse(fs.readFileSync(coveragePath, "utf-8"));

  let stmtTotal = 0;
  let stmtCovered = 0;
  let fnTotal = 0;
  let fnCovered = 0;
  let branchTotal = 0;
  let branchCovered = 0;
  const lineMap = new Map<number, { total: number; covered: number }>();

  for (const data of Object.values(coverage)) {
    stmtTotal += Object.keys(data.statementMap).length;
    stmtCovered += Object.values(data.s).filter((v) => v > 0).length;

    fnTotal += Object.keys(data.fnMap).length;
    fnCovered += Object.values(data.f).filter((v) => v > 0).length;

    for (const bm of Object.values(data.branchMap)) {
      branchTotal += bm.locations?.length || (bm.type === "binary-expr" ? 2 : bm.type === "if" ? 2 : 1);
    }
    for (const counts of Object.values(data.b)) {
      branchCovered += counts.filter((c) => c > 0).length;
    }

    for (const [idx, loc] of Object.entries(data.statementMap)) {
      const line = loc.start?.line;
      if (line === undefined) continue;
      if (!lineMap.has(line)) lineMap.set(line, { total: 0, covered: 0 });
      lineMap.get(line)!.total++;
      if (data.s[idx] > 0) lineMap.get(line)!.covered++;
    }
  }

  const lineTotal = lineMap.size;
  const lineCovered = [...lineMap.values()].filter((v) => v.covered > 0).length;

  return {
    lines: {
      total: lineTotal,
      covered: lineCovered,
      pct: lineTotal ? Math.round((lineCovered / lineTotal) * 100) : 0,
    },
    statements: {
      total: stmtTotal,
      covered: stmtCovered,
      pct: stmtTotal ? Math.round((stmtCovered / stmtTotal) * 100) : 0,
    },
    functions: {
      total: fnTotal,
      covered: fnCovered,
      pct: fnTotal ? Math.round((fnCovered / fnTotal) * 100) : 0,
    },
    branches: {
      total: branchTotal,
      covered: branchCovered,
      pct: branchTotal ? Math.round((branchCovered / branchTotal) * 100) : 0,
    },
  };
}

export function collectCoverageByModule(coveragePath: string): Map<string, CoverageData> {
  const result = new Map<string, CoverageData>();

  if (!coveragePath || !fs.existsSync(coveragePath)) {
    return result;
  }

  const coverage: IstanbulCoverage = JSON.parse(fs.readFileSync(coveragePath, "utf-8"));

  const moduleData = new Map<string, {
    stmtTotal: number; stmtCovered: number;
    fnTotal: number; fnCovered: number;
    branchTotal: number; branchCovered: number;
    lineMap: Map<number, { total: number; covered: number }>;
  }>();

  for (const [filePath, data] of Object.entries(coverage)) {
    const normalized = filePath.replace(/\\/g, "/");
    const moduleMatch = normalized.match(/(?:src\/)?modules\/([^/]+)\//);
    const moduleSlug = moduleMatch ? slugify(moduleMatch[1]) : slugify(normalized.split("/").pop()?.replace(/\.[^.]+$/, "") || "unknown");

    let md = moduleData.get(moduleSlug);
    if (!md) {
      md = { stmtTotal: 0, stmtCovered: 0, fnTotal: 0, fnCovered: 0, branchTotal: 0, branchCovered: 0, lineMap: new Map() };
      moduleData.set(moduleSlug, md);
    }

    md.stmtTotal += Object.keys(data.statementMap).length;
    md.stmtCovered += Object.values(data.s).filter((v) => v > 0).length;

    md.fnTotal += Object.keys(data.fnMap).length;
    md.fnCovered += Object.values(data.f).filter((v) => v > 0).length;

    for (const bm of Object.values(data.branchMap)) {
      md.branchTotal += bm.locations?.length || (bm.type === "binary-expr" ? 2 : bm.type === "if" ? 2 : 1);
    }
    for (const counts of Object.values(data.b)) {
      md.branchCovered += counts.filter((c) => c > 0).length;
    }

    for (const [idx, loc] of Object.entries(data.statementMap)) {
      const line = loc.start?.line;
      if (line === undefined) continue;
      if (!md.lineMap.has(line)) md.lineMap.set(line, { total: 0, covered: 0 });
      md.lineMap.get(line)!.total++;
      if (data.s[idx] > 0) md.lineMap.get(line)!.covered++;
    }
  }

  for (const [moduleSlug, md] of moduleData) {
    const lineTotal = md.lineMap.size;
    const lineCovered = [...md.lineMap.values()].filter((v) => v.covered > 0).length;

    result.set(moduleSlug, {
      lines: {
        total: lineTotal,
        covered: lineCovered,
        pct: lineTotal ? Math.round((lineCovered / lineTotal) * 100) : 0,
      },
      statements: {
        total: md.stmtTotal,
        covered: md.stmtCovered,
        pct: md.stmtTotal ? Math.round((md.stmtCovered / md.stmtTotal) * 100) : 0,
      },
      functions: {
        total: md.fnTotal,
        covered: md.fnCovered,
        pct: md.fnTotal ? Math.round((md.fnCovered / md.fnTotal) * 100) : 0,
      },
      branches: {
        total: md.branchTotal,
        covered: md.branchCovered,
        pct: md.branchTotal ? Math.round((md.branchCovered / md.branchTotal) * 100) : 0,
      },
    });
  }

  return result;
}

function mergeModules(pwModules: TestModule[], vtModules: TestModule[]): TestModule[] {
  const map = new Map<string, TestModule>();

  for (const m of pwModules) {
    map.set(m.slug, { ...m, features: m.features.map((f) => ({ ...f, scenarios: [...f.scenarios] })) });
  }

  for (const m of vtModules) {
    const existing = map.get(m.slug);
    if (existing) {
      const featureMap = new Map<string, Feature>();
      for (const f of existing.features) featureMap.set(f.slug, f);

      for (const vtFeature of m.features) {
        const existingFeature = featureMap.get(vtFeature.slug);
        if (existingFeature) {
          const scenarioMap = new Map<string, Scenario>();
          for (const s of existingFeature.scenarios) scenarioMap.set(s.slug, s);
          for (const s of vtFeature.scenarios) {
            const existingScenario = scenarioMap.get(s.slug);
            if (existingScenario && existingScenario.integration === null && s.e2e === null) {
              existingScenario.integration = s.integration;
              if (existingScenario.status === "passed" && s.status !== "passed") {
                existingScenario.status = s.status;
              }
              existingScenario.duration += s.duration;
            } else {
              scenarioMap.set(s.slug, s);
            }
          }
          existingFeature.scenarios = [...scenarioMap.values()];
        } else {
          featureMap.set(vtFeature.slug, { ...vtFeature, scenarios: [...vtFeature.scenarios] });
        }
      }

      existing.features = [...featureMap.values()];

      const allScenarios = existing.features.flatMap((f) => f.scenarios);
      existing.stats.integration = m.stats.integration;
      existing.stats.total = allScenarios.length;
      existing.stats.passed = allScenarios.filter((s) => s.status === "passed").length;
      existing.stats.failed = allScenarios.filter((s) => s.status === "failed").length;
      existing.stats.skipped = allScenarios.filter((s) => s.status === "skipped").length;
      existing.stats.duration += m.stats.duration;
    } else {
      map.set(m.slug, { ...m, features: m.features.map((f) => ({ ...f, scenarios: [...f.scenarios] })) });
    }
  }

  return [...map.values()];
}

export function buildReportJson(opts: {
  playwrightPath?: string;
  vitestPath?: string;
  coveragePath?: string;
  prebuiltPath?: string;
}): BuildResult {
  if (opts.prebuiltPath) {
    if (!fs.existsSync(opts.prebuiltPath)) {
      throw new Error(`Pre-built report not found: ${opts.prebuiltPath}`);
    }
    return { report: JSON.parse(fs.readFileSync(opts.prebuiltPath, "utf-8")), pwAssets: [] };
  }

  const pw = extractPwModules(opts.playwrightPath || "");
  const vt = extractVitestModules(opts.vitestPath || "");
  const coverage = collectCoverage(opts.coveragePath || "");

  const modules = mergeModules(pw.modules, vt.modules);

  const moduleCoverage = collectCoverageByModule(opts.coveragePath || "");
  for (const mod of modules) {
    const cov = moduleCoverage.get(mod.slug);
    if (cov) {
      mod.coverage.merged = cov;
    }
  }

  const passed = pw.totalPassed + vt.totalPassed;
  const failed = pw.totalFailed + vt.totalFailed;
  const skipped = pw.totalSkipped + vt.totalSkipped;
  const duration = pw.totalDuration + vt.totalDuration;
  const testCases = pw.totalTestCases + vt.totalTestCases;

  if (testCases === 0) {
    throw new Error(
      "No test results found. Provide at least one of: playwright-report, vitest-report, or report-json.",
    );
  }

  const totalFeatures = modules.reduce((sum, m) => sum + m.features.length, 0);

  return {
    report: {
      dashboard: {
        modules: modules.length,
        features: totalFeatures,
        scenarios: testCases,
        testCases,
        passed,
        failed,
        skipped,
        duration,
        coverage,
      },
      modules,
    },
    pwAssets: pw.pwAssets,
  };
}

export async function discoverAssets(
  assetsDir: string,
): Promise<{ name: string; path: string; type: "screenshot" | "video" | "coverage"; size: number; content_type: string }[]> {
  if (!assetsDir || !fs.existsSync(assetsDir)) {
    return [];
  }

  const patterns = [
    { glob: "**/*.png", type: "screenshot" as const, ct: "image/png" },
    { glob: "**/*.jpg", type: "screenshot" as const, ct: "image/jpeg" },
    { glob: "**/*.webm", type: "video" as const, ct: "video/webm" },
    { glob: "**/*.mp4", type: "video" as const, ct: "video/mp4" },
    { glob: "**/coverage-summary.json", type: "coverage" as const, ct: "application/json" },
  ];

  const assets: { name: string; path: string; type: "screenshot" | "video" | "coverage"; size: number; content_type: string }[] = [];

  for (const p of patterns) {
    const files = await glob(p.glob, { cwd: assetsDir, absolute: true });
    for (const filePath of files) {
      const stat = fs.statSync(filePath);
      const relativePath = path.relative(assetsDir, filePath);
      assets.push({
        name: relativePath,
        path: filePath,
        type: p.type,
        size: stat.size,
        content_type: p.ct,
      });
    }
  }

  return assets;
}
