// Launches the Worker's `wrangler dev` bound to $PORT instead of a hardcoded port, so
// .claude/launch.json's "api" config can set autoPort:true and coexist with another session's
// dev server. Plain `npm run dev --workspace @plantain/api -- --port 8787` can't do this itself:
// wrangler has no PORT-env convention of its own, only a --port flag, so something has to read
// the harness-assigned $PORT and forward it explicitly.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const apiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api');
const port = process.env.PORT || '8787';

const child = spawn('npx', ['wrangler', 'dev', '--port', port], {
  cwd: apiDir,
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
