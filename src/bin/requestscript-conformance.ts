#!/usr/bin/env node
// Runs the deterministic conformance suite against this installation, and exits 1 if any case differs.
import { CONFORMANCE_CASES, runConformance } from '../conformance/index.js';

runConformance()
  .then(({ passed, failures }) => {
    for (const failure of failures) {
      console.error(`✗ ${failure.name}`);
      for (const { output, expected, actual } of failure.differences) {
        console.error(`    ${output}\n      expected ${expected}\n      actual   ${actual}`);
      }
    }
    console.log(`${passed} of ${CONFORMANCE_CASES.length} conformance cases passed`);
    process.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
