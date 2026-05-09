# Fixes Electron preload bridge on Windows by compiling preload as CommonJS .cjs.
# Run from the app/ folder.
$ErrorActionPreference = "Stop"

node -e "const fs=require('fs'); const p='package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.scripts['electron:compile']='tsc electron/main.ts --skipLibCheck --outDir electron-dist --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --resolveJsonModule && tsc electron/preload.ts --skipLibCheck --outDir electron-dist --module commonjs --moduleResolution node --target es2022 --esModuleInterop --resolveJsonModule && node -e \"const fs=require(\\\'fs\\\'); if (fs.existsSync(\\\'electron-dist/preload.cjs\\\')) fs.rmSync(\\\'electron-dist/preload.cjs\\\'); fs.renameSync(\\\'electron-dist/preload.js\\\',\\\'electron-dist/preload.cjs\\\')\"'; fs.writeFileSync(p, JSON.stringify(j,null,2));"

node -e "const fs=require('fs'); const p='electron/main.ts'; let s=fs.readFileSync(p,'utf8'); s=s.replace(\"preload: path.join(__dirname, 'preload.js'),\", \"preload: path.join(__dirname, 'preload.cjs'),\"); fs.writeFileSync(p,s);"

Write-Host "Patched Electron bridge. Now run: npm run electron:dev"
