import { performance } from "node:perf_hooks";
import { planQuery } from "../src/lib/query-intent";
import { REFERENCE_DATE, REGRESSION_CASES } from "../tests/regression-cases";

let passed = 0;
let deterministic = 0;
let fallback = 0;
const started = performance.now();

for (const regression of REGRESSION_CASES) {
  const caseStarted = performance.now();
  const plan = planQuery(regression.question, REFERENCE_DATE);
  const elapsed = performance.now() - caseStarted;

  if (plan.path === "gemini") {
    fallback += 1;
    console.log(`FAIL ${regression.id}: Gemini fallback (${elapsed.toFixed(2)} ms)`);
    continue;
  }

  deterministic += 1;
  const argsMatch = Object.entries(regression.args).every(
    ([key, value]) => JSON.stringify(plan.args[key]) === JSON.stringify(value),
  );
  const ok =
    plan.tool === regression.tool &&
    plan.intent === regression.intent &&
    argsMatch;
  if (ok) passed += 1;

  console.log(
    `${ok ? "PASS" : "FAIL"} ${regression.id}: ${plan.tool} (${elapsed.toFixed(2)} ms)`,
  );
}

const elapsed = performance.now() - started;
console.log("");
console.log(
  `Result: ${passed}/${REGRESSION_CASES.length} passed · ${deterministic} deterministic · ${fallback} Gemini fallback · ${elapsed.toFixed(2)} ms total`,
);

if (passed !== REGRESSION_CASES.length) process.exitCode = 1;
