"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const files = fs.readdirSync(root).filter((file) => file.endsWith(".js")).sort();

let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], {
    encoding: "utf8",
  });

  if (result.status === 0) {
    console.log(`ok   ${file}`);
  } else {
    failed += 1;
    console.error(`FAIL ${file}\n${result.stderr.trim()}`);
  }
}

console.log(failed === 0 ? `\n${files.length} files OK` : `\n${failed} file(s) failed`);
process.exit(failed === 0 ? 0 : 1);
