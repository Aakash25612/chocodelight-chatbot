import { performance } from "node:perf_hooks";
import { REGRESSION_CASES } from "../tests/regression-cases";
import { getDirectResponse } from "../src/lib/direct-responses";
import { runGeminiChat } from "../src/lib/gemini-chat";
import { runWithMirrorCache } from "../src/lib/mirror-cache";

async function main(): Promise<void> {
  let passed = 0;
  const started = performance.now();

  await runWithMirrorCache(async () => {
    for (const regression of REGRESSION_CASES) {
      const caseStarted = performance.now();
      try {
        const direct = await getDirectResponse(
          regression.question,
          "saurabhfood",
        );
        const source = direct ? "deterministic" : "gemini";
        const answer =
          direct ??
          (
            await runGeminiChat({
              history: [],
              lastMessage: regression.question,
            })
          ).text;
        const ok = answer.trim().length > 0 && !/^error\b/i.test(answer.trim());
        if (ok) passed += 1;
        console.log(
          `${ok ? "PASS" : "FAIL"} ${regression.id}: ${source} (${(performance.now() - caseStarted).toFixed(0)} ms)`,
        );
      } catch (error) {
        console.log(
          `FAIL ${regression.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });

  console.log("");
  console.log(
    `Live result: ${passed}/${REGRESSION_CASES.length} answered · ${(performance.now() - started).toFixed(0)} ms total`,
  );
  if (passed !== REGRESSION_CASES.length) process.exitCode = 1;
}

void main();
