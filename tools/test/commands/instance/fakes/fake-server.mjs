// A fake instance server process: records its arguments and answers every HTTP request with 404.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const args = process.argv.slice(2);
writeFileSync(join(process.env.FAKE_LOG_DIR, 'server.args.json'), JSON.stringify(args));
const secretFile = args[args.indexOf('--secret-file') + 1];
if (args.includes('--secret-file')) writeFileSync(join(process.env.FAKE_LOG_DIR, 'server.secrets.json'), readFileSync(secretFile, 'utf8'));
if (process.env.FAKE_SERVER_EXIT) process.exit(Number(process.env.FAKE_SERVER_EXIT));
const port = Number(args[args.indexOf('--port') + 1]);
createServer((req, res) => {
  res.writeHead(404);
  res.end();
}).listen(port, '127.0.0.1');
