import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true });
process.env.PORT ||= '4001';
const db = await PGlite.create('./server/data');
const socket = new PGLiteSocketServer({ db, port: 55432, host: '127.0.0.1', maxConnections: 10 });
await socket.start();
console.log('Local PostgreSQL-compatible PGlite is listening on 127.0.0.1:55432');
const npmCli = process.env.npm_execpath;
const child = spawn(process.execPath, [npmCli, 'run', 'dev:stack'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55432/postgres', DB_POOL_SIZE: '1' },
});
const shutdown = async (code = 0) => {
  child.kill('SIGINT');
  await socket.stop();
  await db.close();
  process.exit(code);
};
child.on('exit', code => shutdown(code ?? 1));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
