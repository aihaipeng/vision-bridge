const fs = require('node:fs');
const { ProviderLeaseManager } = require('../../scripts/workflow/provider_lease');

async function main() {
  const [root, logPath, label, holdMs] = process.argv.slice(2);
  const manager = new ProviderLeaseManager({ tempRoot: root, pollMs: 2 });
  await manager.run('zhipu', async () => {
    fs.appendFileSync(logPath, `${label},start,${Date.now()}\n`);
    await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
    fs.appendFileSync(logPath, `${label},end,${Date.now()}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
