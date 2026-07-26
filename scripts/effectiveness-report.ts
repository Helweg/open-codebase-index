import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";

import { EFFECTIVENESS_FIXTURES } from "../benchmarks/fixtures/privacy-safe-effectiveness.js";
import { buildEffectivenessEvaluationReport } from "../src/eval/effectiveness-report.js";

const outputPath = path.resolve("benchmarks/baselines/privacy-safe-effectiveness.json");
const report = buildEffectivenessEvaluationReport(EFFECTIVENESS_FIXTURES);
const serialized = `${JSON.stringify(report, null, 2)}\n`;

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, serialized, "utf8");
process.stdout.write(serialized);
