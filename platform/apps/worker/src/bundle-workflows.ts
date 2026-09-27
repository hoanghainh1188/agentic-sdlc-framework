#!/usr/bin/env node
// Bundles the workflow code into `dist/workflow-bundle.js` (task B07, ADR-M30 §2.1). The worker
// image runs this at build time, so the container needs no bundler at start-up.
import { writeWorkflowBundle, WORKFLOW_BUNDLE_PATH } from './temporal.js';

writeWorkflowBundle()
  .then(() => process.stdout.write(`${WORKFLOW_BUNDLE_PATH}\n`))
  .catch((error: unknown) => {
    process.stderr.write(
      `bundle-workflows: ${error instanceof Error ? error.message : 'failed'}\n`,
    );
    process.exitCode = 1;
  });
