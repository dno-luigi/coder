import { installPrebuild } from './index.js';

installPrebuild(process.cwd()).then(evidence => {
  console.log(`Governance prebuild verified: ${evidence.prebuild_id}`);
}).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
