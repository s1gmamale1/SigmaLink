const fs = require('fs');

const p = 'package.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

j.scripts['electron:compile'] = 'tsc electron/main.ts --skipLibCheck --outDir electron-dist --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --resolveJsonModule && tsc electron/preload.ts --skipLibCheck --outDir electron-dist --module commonjs --moduleResolution node --target es2022 --esModuleInterop --resolveJsonModule && node scripts/rename-preload.cjs';

fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
