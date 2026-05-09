const fs = require('fs');

const p = 'electron/main.ts';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  /preload:\s*path\.join\(__dirname,\s*['"]preload\.js['"]\)/g,
  "preload: path.join(__dirname, 'preload.cjs')"
);

fs.writeFileSync(p, s);
