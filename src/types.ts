export type TestStatus = "passed" | "failed" | "skipped" | "pending" | "timedOut" | "interrupted";
export type TestType = "e2e" | "integration";

export interface ContractSnapshot {
  seed?: Record<string, unknown[]>;
  request?: { method: string; path: string; body: unknown };
  response?: unknown;
  expectedState?: Record<string, unknown[]>;
}

export interface RuntimeSnapshot {
  seed?: Record<string, unknown[]>;
  request?: unknown;
  response?: unknown;
  expectedState?: Record<string, unknown[]>;
}

export interface TestStep {
  title: string;
  status: TestStatus;
  duration: number;
  screenshots: string[];
  error?: string;
  isBdd: boolean;
  bddKeyword?: "DADO" | "QUANDO" | "ENTÃO" | "E";
  isDescribe?: boolean;
  expects?: string[];
  attachments: { name: string; path: string; contentType: string }[];
  contractData?: ContractSnapshot;
  runtimeData?: RuntimeSnapshot;
}

export interface TestCase {
  id: string;
  title: string;
  status: TestStatus;
  duration: number;
  type: TestType;
  steps: TestStep[];
  screenshots: string[];
  video?: string;
  error?: string;
  retries: number;
  attachments: { name: string; path: string; contentType: string }[];
}

export interface Scenario {
  id: string;
  name: string;
  slug: string;
  moduleSlug: string;
  featureSlug: string;
  e2e: TestCase | null;
  integration: TestCase | null;
  status: TestStatus;
  duration: number;
}

export interface CoverageData {
  lines: { total: number; covered: number; pct: number };
  statements: { total: number; covered: number; pct: number };
  functions: { total: number; covered: number; pct: number };
  branches: { total: number; covered: number; pct: number };
}

export interface FeatureStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  e2e: { total: number; passed: number; failed: number };
  integration: { total: number; passed: number; failed: number };
}

export interface Feature {
  slug: string;
  name: string;
  moduleSlug: string;
  scenarios: Scenario[];
  stats: FeatureStats;
}

export interface ModuleStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  e2e: { total: number; passed: number; failed: number };
  integration: { total: number; passed: number; failed: number };
}

export interface TestModule {
  slug: string;
  name: string;
  features: Feature[];
  coverage: { merged: CoverageData | null; e2e: CoverageData | null; integration: CoverageData | null };
  stats: ModuleStats;
}

export interface ReportDashboard {
  modules: number;
  features: number;
  scenarios: number;
  testCases: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  coverage: CoverageData | null;
}

export interface ReportJson {
  dashboard: ReportDashboard;
  modules: TestModule[];
}

export interface AssetDeclaration {
  name: string;
  type: "screenshot" | "video" | "coverage";
  size: number;
  content_type?: string;
}

export interface InitResponse {
  report_id: string;
  report_upload_url: string;
  assets: { name: string; upload_url: string }[];
}

export interface FinalizeResponse {
  report_id: string;
  status: string;
}

export interface UploadConfig {
  apiKey: string;
  endpoint: string;
  prNumber?: string;
  prTitle?: string;
  branch?: string;
  commitSha?: string;
  ciProvider?: "gh_actions" | "gitlab_ci" | "other";
  ciRunId?: string;
  playwrightReport?: string;
  vitestReport?: string;
  coverageReport?: string;
  reportJson?: string;
  assetsDir?: string;
}

export interface PlaywrightReport {
  config: {
    projects: { name: string }[];
  };
  suites: PlaywrightSuite[];
}

export interface PlaywrightSuite {
  title: string;
  file: string;
  specs: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

export interface PlaywrightSpec {
  title: string;
  ok: boolean;
  status: string;
  duration: number;
  tags: string[];
  annotations: { type: string; description: string }[];
  tests: PlaywrightTest[];
  file?: string;
  line?: number;
  column?: number;
  id?: string;
}

export interface PlaywrightTest {
  status: string;
  duration: number;
  error?: string | { message: string; stack: string };
  retries: number;
  results: PlaywrightResult[];
}

export interface PlaywrightResult {
  status: string;
  duration: number;
  error?: string | { message: string; stack: string };
  attachments: PlaywrightAttachment[];
  steps: PlaywrightStep[];
}

export interface PlaywrightAttachment {
  name: string;
  path: string;
  body: string;
  contentType: string;
}

export interface PlaywrightStep {
  title: string;
  duration: number;
  status: string;
  error?: string | { message: string };
  steps?: PlaywrightStep[];
  attachments?: PlaywrightAttachment[];
}

export interface VitestReport {
  testResults: VitestFileResult[];
}

export interface VitestFileResult {
  name: string;
  assertionResults: VitestAssertion[];
}

export interface VitestAssertion {
  title?: string;
  fullName?: string;
  status: string;
  duration: number;
  failureMessages?: string[];
  ancestorTitles?: string[];
  meta?: {
    integrationSteps?: IntegrationStepRaw[];
    [key: string]: unknown;
  };
}

export interface IntegrationStepRaw {
  keyword: string;
  title: string;
  status: string;
  duration: number;
  error?: string;
  contract?: ContractSnapshot;
  runtime?: RuntimeSnapshot;
}

export interface IstanbulCoverage {
  [filePath: string]: {
    path: string;
    statementMap: Record<string, { start: { line: number }; end: { line: number } }>;
    fnMap: Record<string, unknown>;
    branchMap: Record<string, { locations?: unknown[]; type?: string }>;
    s: Record<string, number>;
    f: Record<string, number>;
    b: Record<string, number[]>;
  };
}
