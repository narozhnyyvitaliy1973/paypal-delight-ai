import { buildApp } from "./app.js";
import { loadRootEnv, readConfig } from "./config.js";

loadRootEnv();
const app = buildApp({
  logger: {
    redact: [
      "req.headers.cookie",
      "req.headers.authorization",
      'req.headers["x-delight-lab-token"]',
      'res.headers["set-cookie"]',
    ],
  },
});
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down server");

  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen(readConfig());
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
