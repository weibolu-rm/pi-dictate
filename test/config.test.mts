// Standalone test for the dictate config loader + key parser in index.ts.
// Extracts the relevant sections from index.ts (as TypeScript — Node ≥23.6
// strips types natively), stubs their imports, runs the cases.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import * as pathMod from "node:path";

const src = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
const slice = (startMarker, endMarker) => {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker) + endMarker.length;
  if (s === -1 || e === -1 || e <= s) throw new Error(`extraction failed: ${startMarker}`);
  return src.slice(s, e);
};

const langBody = slice("const NOVA3_LANGUAGE_GROUPS", 'const DEFAULT_LANGUAGE = "en";');
const defaultsBody = src.slice(src.indexOf("interface DictateConfig"), src.indexOf("const KEY_MODIFIERS"));
const cfgBody = src.slice(src.indexOf("const KEY_MODIFIERS"), src.indexOf("export default function"));
const testFile = "/tmp/dictate-cfg-test.mts";

const failures: string[] = [];
const t = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  console.log(ok ? "PASS" : "FAIL", label);
};

const agentDir = "/tmp/dictate-test/agent";
const projDir = "/tmp/dictate-test/proj";
const reset = () => {
  rmSync("/tmp/dictate-test", { recursive: true, force: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projDir + "/.pi", { recursive: true });
};

writeFileSync(
  testFile,
  `
import { existsSync, readFileSync } from "node:fs";
import * as pathMod from "node:path";
const join = pathMod.join;
const getAgentDir = () => ${JSON.stringify(agentDir)};
${langBody}
${defaultsBody}
${cfgBody}
export { parseConfiguredKey, loadConfig };
`
);

const { parseConfiguredKey, loadConfig } = await import(testFile);

// parseConfiguredKey
t("alt+m", parseConfiguredKey("alt+m"), "alt+m");
t("case+space", parseConfiguredKey("  ALT+M "), "alt+m");
t("shift+alt+m", parseConfiguredKey("shift+alt+m"), "shift+alt+m");
t("alt+shift+m", parseConfiguredKey("alt+shift+m"), "alt+shift+m");
t("ctrl+shift+d", parseConfiguredKey("ctrl+shift+d"), "ctrl+shift+d");
t("f6 bare", parseConfiguredKey("f6"), "f6");
t("escape bare", parseConfiguredKey("escape"), "escape");
t("up bare", parseConfiguredKey("up"), "up");
t("ctrl+,", parseConfiguredKey("ctrl+,"), "ctrl+,");
t("dedupe alt+alt+m", parseConfiguredKey("alt+alt+m"), "alt+m");
t("plain m rejected", parseConfiguredKey("m"), null);
t("plain space rejected", parseConfiguredKey("space"), null);
t("enter rejected", parseConfiguredKey("enter"), null);
t("bad modifier", parseConfiguredKey("meta+m"), null);
t("bad key", parseConfiguredKey("alt+qbert"), null);
t("empty", parseConfiguredKey(""), null);
t("trailing +", parseConfiguredKey("alt+m+"), null);
t("plus key", parseConfiguredKey("+"), null);

// loadConfig
reset();
t("defaults", loadConfig(projDir).config, { toggleKey: "alt+m", cancelKey: "alt+n", language: "en" });

writeFileSync(agentDir + "/settings.json", JSON.stringify({ dictate: { toggleKey: "ctrl+shift+d", language: "sv" } }));
let r = loadConfig(projDir);
t("global applied", r.config, { toggleKey: "ctrl+shift+d", cancelKey: "alt+n", language: "sv" });
t("global no warnings", r.warnings, []);

writeFileSync(projDir + "/.pi/settings.json", JSON.stringify({ dictate: { cancelKey: "f6", toggleKey: "plain", language: "klingon" } }));
r = loadConfig(projDir);
t("project override + invalid", r.config, { toggleKey: "ctrl+shift+d", cancelKey: "f6", language: "sv" });
console.log("  warnings →", r.warnings);

writeFileSync(agentDir + "/settings.json", "{not json");
r = loadConfig(projDir);
t("malformed global, project still applies", r.config, { toggleKey: "alt+m", cancelKey: "f6", language: "en" });

writeFileSync(agentDir + "/settings.json", JSON.stringify({ dictate: { toggleKey: 42 } }));
r = loadConfig(projDir);
t("wrong type toggleKey", r.config.toggleKey, "alt+m");
console.log("  warnings →", r.warnings);

writeFileSync(agentDir + "/settings.json", JSON.stringify({ theme: "dark" }));
rmSync(projDir + "/.pi/settings.json");
r = loadConfig(projDir);
t("no dictate section", r.config, { toggleKey: "alt+m", cancelKey: "alt+n", language: "en" });
t("no warnings", r.warnings, []);

rmSync("/tmp/dictate-test", { recursive: true, force: true });
rmSync(testFile, { force: true });

if (failures.length) {
  console.error("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\nAll config tests passed.");
