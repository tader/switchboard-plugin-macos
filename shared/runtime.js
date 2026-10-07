import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class AdapterError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const invalid = message => new AdapterError('invalid_input', message);
export function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected a JSON object.');
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) throw invalid(`Accepted fields: ${allowed.join(', ')}.`);
  return value;
}
export function string(value, name, max = 20000, empty = false) {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw invalid(`${name} must be ${empty ? '' : 'nonempty '}text of at most ${max} characters without control characters.`);
  return value;
}
export function boolean(value, name) {
  if (typeof value !== 'boolean') throw invalid(`${name} must be true or false.`);
  return value;
}
export function date(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid(`${name} must be an ISO 8601 date-time with an explicit time zone.`);
  const parts = value.slice(0, 10).split('-').map(Number);
  const monthEnd = new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > monthEnd) throw invalid(`${name} has an invalid calendar date.`);
  return value;
}
export function query(url, names) {
  for (const key of url.searchParams.keys()) {
    if (!names.includes(key) || url.searchParams.getAll(key).length !== 1) throw invalid(`Unknown or repeated query parameter: ${key}.`);
  }
}
export function page(url, scope = '') {
  const size = url.searchParams.get('pageSize') ?? '100';
  if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 100) throw invalid('pageSize must be between 1 and 100.');
  const filters = new URLSearchParams(url.searchParams); filters.delete('nextToken'); filters.sort();
  const fingerprint = createHash('sha256').update(JSON.stringify([scope, url.pathname, filters.toString()])).digest('hex');
  let offset = 0;
  const token = url.searchParams.get('nextToken');
  if (token) {
    try {
      const data = JSON.parse(Buffer.from(token, 'base64url').toString());
      if (data.fingerprint !== fingerprint || !Number.isSafeInteger(data.offset) || data.offset < 0) throw new Error();
      offset = data.offset;
    } catch { throw invalid('nextToken is invalid or belongs to another account or query.'); }
  }
  return { offset, limit: Number(size), fingerprint };
}
export function pageResult(value, fingerprint) {
  if (!value || !Array.isArray(value.items)) throw new AdapterError('invalid_helper_response', 'Expected a native result page.', 502);
  const { nextOffset, ...result } = value;
  if (nextOffset !== undefined) {
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 1) throw new AdapterError('invalid_helper_response', 'Invalid native nextOffset.', 502);
    result.nextToken = Buffer.from(JSON.stringify({ offset: nextOffset, fingerprint })).toString('base64url');
  }
  return result;
}
export function identifier(value) {
  try {
    string(value, 'identifier', 4096);
    return object(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch { throw invalid('Invalid opaque identifier. Use an ID returned by this plugin.'); }
}
export const opaque = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export class SerialQueue {
  constructor(max = 20) { this.tails = new Map(); this.counts = new Map(); this.max = max; }
  async run(key, task) {
    const count = this.counts.get(key) ?? 0;
    if (count >= this.max) throw new AdapterError('queue_full', 'Native operation queue is full.', 429);
    this.counts.set(key, count + 1);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    this.tails.set(key, next);
    await previous;
    try { return await task(); }
    finally {
      this.counts.set(key, this.counts.get(key) - 1); release();
      if (this.tails.get(key) === next) { this.tails.delete(key); this.counts.delete(key); }
    }
  }
  async drain() { await Promise.all(this.tails.values()); }
}

export class Ledger {
  constructor(file) { this.file = file; }
  async write(records) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(records)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, this.file);
    const directory = await fs.open(path.dirname(this.file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async run(key, identity, execute) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw invalid('idempotencyKey must be 8–128 letters, digits or . _ : - characters.');
    let records;
    try { records = object(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') records = {}; else throw error; }
    const index = createHash('sha256').update(key).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const previous = records[index];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AdapterError('idempotency_conflict', 'This key belongs to a different operation or payload.', 409);
      if (previous.result) return { ...previous.result, body: { ...previous.result.body, replayed: true } };
      throw new AdapterError('mutation_uncertain', 'This operation was attempted but not confirmed. Inspect the app; do not retry with a new key.', 409);
    }
    if (Object.keys(records).length >= 10000) throw new AdapterError('ledger_full', 'The durable operation ledger is full.', 503);
    records[index] = { fingerprint, attemptedAt: new Date().toISOString() };
    await this.write(records);
    let result;
    try { result = await execute(); }
    catch { throw new AdapterError('mutation_uncertain', 'The native operation could not be confirmed. Inspect the app; do not retry with a new key.', 409); }
    // Even a native error after execution may follow a partial mutation. Keep intent.
    if (result.status < 200 || result.status >= 300) throw new AdapterError('mutation_uncertain', `The native operation could not be confirmed: ${JSON.stringify(result.body)}. Inspect the app before trying again.`, 409);
    records[index].result = result;
    try { await this.write(records); }
    catch { throw new AdapterError('mutation_uncertain', 'The operation completed but its receipt could not be saved. Inspect the app before trying again.', 409); }
    return result;
  }
}

export async function buildHelper(ctx, frameworks, { spawnProcess = spawn } = {}) {
  await fs.mkdir(ctx.dataDir, { recursive: true, mode: 0o700 });
  const source = path.join(ctx.dir, 'helper.swift'), plist = path.join(ctx.dir, 'Info.plist');
  const helper = path.join(ctx.dataDir, `${ctx.manifest.id}-helper`), stamp = `${helper}.version`;
  const hash = createHash('sha256').update(await fs.readFile(source)).update(await fs.readFile(plist)).update(process.arch);
  try { hash.update(await fs.readFile(path.join(ctx.dir, 'mail.js'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const version = hash.digest('hex');
  if (await fs.readFile(stamp, 'utf8').catch(() => '') === version && await fs.access(helper).then(() => true, () => false)) return helper;
  const temporary = `${helper}.${randomUUID()}.tmp`;
  try {
    await new Promise((resolve, reject) => {
      const args = [source, '-o', temporary, '-module-cache-path', path.join(ctx.dataDir, 'module-cache'), ...frameworks.flatMap(name => ['-framework', name]), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist];
      const child = spawnProcess('/usr/bin/swiftc', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new AdapterError('build_timeout', 'Native helper compilation timed out.', 503)); }, 120000);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new AdapterError('build_failed', stderr.trim() || `swiftc exited ${code}. Install Xcode Command Line Tools.`, 503)); });
    });
    await fs.rename(temporary, helper); await fs.writeFile(stamp, version, { mode: 0o600 });
    return helper;
  } finally { await fs.rm(temporary, { force: true }); }
}
export function runHelper(helper, input, { spawnProcess = spawn, timeoutMs = 60000, args = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let stderr = '', bytes = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new AdapterError('helper_timeout', 'Native helper timed out. Check the app and privacy permissions.', 504)); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { child.kill('SIGKILL'); finish(new AdapterError('response_too_large', 'Native response exceeds 8 MiB.', 502)); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.once('close', code => {
      if (code !== 0) return finish(new AdapterError('helper_failed', stderr.trim() || `Native helper exited ${code}.`, 502));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599 || !Object.hasOwn(result, 'body')) throw new Error();
        finish(null, result);
      } catch { finish(new AdapterError('invalid_helper_response', 'Native helper returned invalid JSON.', 502)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
export async function jsonBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024) throw new AdapterError('body_too_large', 'Maximum body size is 128 KiB.', 413); chunks.push(chunk); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString())); }
  catch (error) { if (error instanceof AdapterError) throw error; throw invalid('Body must contain a JSON object.'); }
}

export async function createAdapter(ctx, definition, { platform = process.platform, createServer = http.createServer, runNative } = {}) {
  if (platform !== 'darwin') return {};
  let disposed = false, building;
  const native = runNative ?? (async input => {
    if (!building) building = buildHelper(ctx, definition.frameworks).catch(error => { building = undefined; throw error; });
    return runHelper(await building, input, { args: definition.helperArgs?.(ctx) ?? [] });
  });
  const queue = new SerialQueue(), invocations = new Map();
  const respond = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
  const server = createServer(async (request, response) => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const invocation = invocations.get(token); invocations.delete(token);
    if (disposed || !invocation || invocation.expires < Date.now()) return respond(response, 401, { error: { code: 'invalid_invocation', message: 'Invalid or expired invocation.' } });
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method !== invocation.method || url.pathname !== invocation.pathname || url.search !== invocation.search) throw new AdapterError('invocation_mismatch', 'Invocation belongs to a different request.', 403);
      const body = ['POST', 'PATCH'].includes(request.method) ? await jsonBody(request) : undefined;
      const route = definition.route(request.method, url, body, invocation.scope);
      if (!route) throw new AdapterError('not_found', 'Unknown operation.', 404);
      const result = await queue.run('native', async () => {
        if (disposed || response.destroyed) throw new AdapterError('cancelled', 'Request was cancelled before native execution.', 503);
        const execute = () => native({ ...route.input, scope: invocation.scope });
        if (!route.idempotencyKey) return execute();
        const filename = createHash('sha256').update(JSON.stringify(invocation.scope)).digest('hex');
        return new Ledger(path.join(ctx.dataDir, 'ledgers', `${filename}.json`)).run(route.idempotencyKey, [invocation.scope, route.input], execute);
      });
      respond(response, result.status, route.page && result.status === 200 ? pageResult(result.body, route.page.fingerprint) : result.body);
    } catch (error) { respond(response, error.status ?? 500, { error: { code: error.code ?? 'adapter_error', message: error.message } }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const prune = setInterval(() => { for (const [key, value] of invocations) if (value.expires < Date.now()) invocations.delete(key); }, 10000); prune.unref();
  return {
    services: [{ id: ctx.manifest.id, name: ctx.manifest.name, description: ctx.manifest.description, icon: 'icon.svg', baseUrl: `http://${ctx.manifest.id}.localhost`, allowedHosts: [`${ctx.manifest.id}.localhost`, new URL(baseUrl).host], openapi: definition.openapi,
      authMethods: [{ id: definition.authId, name: definition.authName, fields: definition.fields,
        async connect({ config = {} } = {}) {
          if (disposed) throw new AdapterError('disposed', 'Plugin has been unloaded.', 503);
          const input = definition.connectInput(config);
          const result = await queue.run('native', () => native(input));
          if (result.status !== 200) throw new Error(result.body?.error?.message ?? result.body?.error ?? 'Native access was not granted.');
          const connected = definition.connected(result.body);
          return { credentials: { token: randomBytes(32).toString('base64url'), scope: connected.scope }, account: connected.account };
        },
        authorize(request, connection) {
          if (disposed) throw new AdapterError('disposed', 'Plugin has been unloaded.', 503);
          const creds = connection.credentials;
          if (!creds || typeof creds.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(creds.token)) throw new AdapterError('invalid_connection', 'Invalid local connection.', 401);
          definition.validateScope(creds.scope);
          request.url.host = new URL(baseUrl).host; request.url.protocol = 'http:';
          const token = randomBytes(32).toString('base64url');
          invocations.set(token, { credential: creds.token, scope: creds.scope, method: request.method, pathname: request.url.pathname, search: request.url.search, expires: Date.now() + 10000 });
          request.headers.set('authorization', `Bearer ${token}`);
        },
        async revoke(connection) { for (const [key, value] of invocations) if (value.credential === connection.credentials.token) invocations.delete(key); },
      }],
    }],
    async dispose() { disposed = true; clearInterval(prune); invocations.clear(); await queue.drain(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }); },
  };
}
