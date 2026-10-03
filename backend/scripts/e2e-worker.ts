/** Runs exactly one poll of the REAL worker against whatever env/DB it is pointed at. */
import { pollOnce, realDeps } from "../src/triggerWorker";

const deps = realDeps();
const lines: string[] = [];
deps.log = (m) => lines.push(m);

pollOnce(deps)
  .then(() => {
    console.log(lines.length ? lines.join("\n") : "(worker took no action)");
  })
  .catch((e) => {
    console.error("POLL FAILED:", e);
    process.exit(1);
  });
