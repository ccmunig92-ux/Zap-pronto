import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

export default class NoUnexpectedSkipsReporter implements Reporter {
  private readonly skipped: string[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "skipped") this.skipped.push(test.titlePath().join(" > "));
  }

  onEnd(_result: FullResult): { status?: FullResult["status"] } {
    if (this.skipped.length === 0) return {};
    process.stderr.write(`UNEXPECTED_E2E_SKIPS:${this.skipped.join(" | ")}\n`);
    return { status: "failed" };
  }
}
