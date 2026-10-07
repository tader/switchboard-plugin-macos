import path from 'node:path';
import { createAdapter, object, string, boolean, date, invalid, query, page, identifier } from './lib/runtime.js';

export function email(value, name = 'email') {
  string(value, name, 320);
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)) throw invalid(`${name} must be one email address without display names.`);
  return value.trim().toLowerCase();
}
export function scopeCheck(scope) { object(scope, ['accountId', 'email']); string(scope.accountId, 'accountId', 4096); email(scope.email); }
export function target(value, scope, message = false) {
  const result = identifier(value);
  object(result, message ? ['accountId', 'path', 'nativeId', 'messageId'] : ['accountId', 'path']);
  if (result.accountId !== scope.accountId) throw invalid('This identifier belongs to another Mail account.');
  if (!Array.isArray(result.path) || !result.path.length || result.path.length > 50) throw invalid('Invalid mailbox hierarchy.');
  result.path.forEach(part => string(part, 'mailbox name', 1000));
  if (message) {
    if (!Number.isSafeInteger(result.nativeId) || result.nativeId < 1) throw invalid('Invalid native message ID.');
    if (result.messageId !== null) string(result.messageId, 'messageId', 2000, true);
  }
  return result;
}
export function compose(value, reply = false) {
  object(value, reply ? ['text', 'replyAll', 'idempotencyKey'] : ['to', 'cc', 'bcc', 'subject', 'text', 'idempotencyKey']);
  const input = { text: string(value.text, 'text', 20000), idempotencyKey: string(value.idempotencyKey, 'idempotencyKey', 128) };
  if (reply) { if (value.replyAll !== undefined) input.replyAll = boolean(value.replyAll, 'replyAll'); }
  else {
    input.subject = string(value.subject, 'subject', 1000, true);
    for (const key of ['to', 'cc', 'bcc']) {
      const list = value[key] ?? [];
      if (!Array.isArray(list) || list.length > 100) throw invalid(`${key} must be an array of at most 100 email addresses.`);
      input[key] = list.map(item => email(item, key));
    }
    if (!input.to.length) throw invalid('At least one to recipient is required.');
  }
  return input;
}
export function route(method, url, body, scope) {
  scopeCheck(scope);
  const pagingNames = ['pageSize', 'nextToken'];
  if (method === 'GET' && url.pathname === '/account') { query(url, []); return { input: { operation: 'account' } }; }
  if (method === 'GET' && url.pathname === '/mailboxes') {
    query(url, pagingNames); const paging = page(url, JSON.stringify(scope));
    return { input: { operation: 'mailboxes', offset: paging.offset, limit: paging.limit }, page: paging };
  }
  if (method === 'GET' && url.pathname === '/messages') {
    query(url, [...pagingNames, 'mailboxId', 'query', 'sender', 'recipient', 'receivedAfter', 'receivedBefore', 'unreadOnly', 'flagged', 'maxScan']);
    const paging = page(url, JSON.stringify(scope)), input = { operation: 'messages', offset: paging.offset, limit: paging.limit };
    if (url.searchParams.has('mailboxId')) input.mailbox = target(url.searchParams.get('mailboxId'), scope);
    for (const key of ['query', 'sender', 'recipient']) if (url.searchParams.has(key)) input[key] = string(url.searchParams.get(key), key, 500);
    for (const key of ['receivedAfter', 'receivedBefore']) if (url.searchParams.has(key)) input[key] = date(url.searchParams.get(key), key);
    if (input.receivedAfter && input.receivedBefore && Date.parse(input.receivedAfter) >= Date.parse(input.receivedBefore)) throw invalid('receivedBefore must follow receivedAfter.');
    for (const key of ['unreadOnly', 'flagged']) if (url.searchParams.has(key)) {
      const value = url.searchParams.get(key); if (!['true', 'false'].includes(value)) throw invalid(`${key} must be true or false.`); input[key] = value === 'true';
    }
    const maxScan = url.searchParams.get('maxScan') ?? '1000';
    if (!/^\d+$/.test(maxScan) || Number(maxScan) < 1 || Number(maxScan) > 10000) throw invalid('maxScan must be between 1 and 10000.');
    input.maxScan = Number(maxScan);
    return { input, page: paging };
  }
  query(url, []);
  if (method === 'POST' && ['/drafts', '/messages/send'].includes(url.pathname)) {
    const { idempotencyKey, ...input } = compose(body);
    return { input: { ...input, operation: url.pathname === '/drafts' ? 'draft' : 'send' }, idempotencyKey };
  }
  const match = url.pathname.match(/^\/messages\/([^/]+)(?:\/(reply|move))?$/);
  if (!match) return;
  const message = target(decodeURIComponent(match[1]), scope, true);
  if (method === 'GET' && !match[2]) return { input: { operation: 'get', target: message } };
  if (method === 'PATCH' && !match[2]) {
    object(body, ['read', 'flagged']); const input = {};
    for (const key of ['read', 'flagged']) if (Object.hasOwn(body, key)) input[key] = boolean(body[key], key);
    if (!Object.keys(input).length) throw invalid('Provide read or flagged.');
    return { input: { ...input, operation: 'update', target: message } };
  }
  if (method === 'POST' && match[2] === 'reply') {
    const { idempotencyKey, ...input } = compose(body, true);
    return { input: { ...input, operation: 'reply', target: message }, idempotencyKey };
  }
  if (method === 'POST' && match[2] === 'move') {
    object(body, ['mailboxId', 'idempotencyKey']);
    return { input: { operation: 'move', target: message, destination: target(body.mailboxId, scope) }, idempotencyKey: string(body.idempotencyKey, 'idempotencyKey', 128) };
  }
}
const responses = { 200: { description: 'Native result' }, 400: { description: 'Invalid input' }, 403: { description: 'Mail automation denied or account mismatch' }, 404: { description: 'Message or mailbox not found' }, 409: { description: 'Ambiguous identity or uncertain mutation' } };
const paging = [{ name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } }, { name: 'nextToken', in: 'query', schema: { type: 'string' } }];
const key = { type: 'string', minLength: 8, maxLength: 128, description: 'Reuse the same key for retries. Never retry an uncertain mutation with a new key.' };
const json = schema => ({ required: true, content: { 'application/json': { schema } } });
const composeSchema = { type: 'object', additionalProperties: false, required: ['to', 'subject', 'text', 'idempotencyKey'], properties: { to: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', format: 'email' } }, cc: { type: 'array', maxItems: 100, items: { type: 'string', format: 'email' } }, bcc: { type: 'array', maxItems: 100, items: { type: 'string', format: 'email' } }, subject: { type: 'string', maxLength: 1000 }, text: { type: 'string', minLength: 1, maxLength: 20000 }, idempotencyKey: key } };
export const openapi = { openapi: '3.0.3', info: { title: 'Apple Mail', version: '1.0.0', description: 'Local Apple Mail scripting, scoped to the connected account; locally available messages only.' }, paths: {
  '/account': { get: { operationId: 'getAppleMailAccount', summary: 'Read the connected account', responses } },
  '/mailboxes': { get: { operationId: 'listAppleMailMailboxes', summary: 'List nested mailboxes in the connected account', parameters: paging, responses } },
  '/messages': { get: { operationId: 'listAppleMailMessages', summary: 'List or search locally available messages with bounded scanning', parameters: [...paging, ...['mailboxId', 'query', 'sender', 'recipient'].map(name => ({ name, in: 'query', schema: { type: 'string' } })), ...['receivedAfter', 'receivedBefore'].map(name => ({ name, in: 'query', schema: { type: 'string', format: 'date-time' } })), ...['unreadOnly', 'flagged'].map(name => ({ name, in: 'query', schema: { type: 'boolean' } })), { name: 'maxScan', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 } }], responses } },
  '/drafts': { post: { operationId: 'createAppleMailDraft', summary: 'Create a saved plain-text draft for the connected sender', requestBody: json(composeSchema), responses: { ...responses, 201: { description: 'Saved draft' } } } },
  '/messages/send': { post: { operationId: 'sendAppleMailMessage', summary: 'Ask Mail to send a plain-text message', requestBody: json(composeSchema), responses: { ...responses, 202: { description: 'Mail accepted the send command; this is not a delivery receipt.' } } } },
  '/messages/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    get: { operationId: 'getAppleMailMessage', summary: 'Read plain-text content, headers and message metadata', responses },
    patch: { operationId: 'updateAppleMailMessage', summary: 'Set explicit read or flag state', requestBody: json({ type: 'object', additionalProperties: false, minProperties: 1, properties: { read: { type: 'boolean' }, flagged: { type: 'boolean' } } }), responses },
  },
  '/messages/{id}/reply': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], post: { operationId: 'replyToAppleMailMessage', summary: 'Send a native threaded reply; replyAll defaults to false', requestBody: json({ type: 'object', additionalProperties: false, required: ['text', 'idempotencyKey'], properties: { text: composeSchema.properties.text, replyAll: { type: 'boolean', default: false }, idempotencyKey: key } }), responses: { ...responses, 202: { description: 'Mail accepted the reply command' } } } },
  '/messages/{id}/move': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], post: { operationId: 'moveAppleMailMessage', summary: 'Move a message within the connected account and return its new ID', requestBody: json({ type: 'object', additionalProperties: false, required: ['mailboxId', 'idempotencyKey'], properties: { mailboxId: { type: 'string' }, idempotencyKey: key } }), responses } },
} };
export const definition = { authId: 'automation', authName: 'Mail account on this Mac', fields: [{ key: 'email', label: 'Email address configured in Apple Mail', required: true }], frameworks: ['Foundation', 'AppKit', 'OSAKit'], helperArgs: ctx => [path.join(ctx.dir, 'mail.js')], openapi, route,
  connectInput: config => ({ operation: 'authorize', email: email(config.email) }),
  connected: body => { scopeCheck(body.scope); return { scope: body.scope, account: { id: body.scope.accountId, label: `${body.name} (${body.scope.email})` } }; },
  validateScope: scopeCheck,
};
export default function setup(ctx) { return createAdapter(ctx, definition); }
