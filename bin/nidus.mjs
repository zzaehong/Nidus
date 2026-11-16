#!/usr/bin/env node
try {
  const { main, report } = await import("../dist/cli.js");
  await main().catch(report);
} catch {
  process.stderr.write('Nidus build unavailable. Run npm ci && npm run build.\n');
  process.exitCode = 1;
}
