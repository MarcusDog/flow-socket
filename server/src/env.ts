import { existsSync } from "node:fs";
import path from "node:path";

import { config } from "dotenv";

const candidateFiles = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../.env"),
];

for (const envFile of candidateFiles) {
  if (existsSync(envFile)) {
    config({ path: envFile, override: false });
  }
}
