import { createAdapter, object, string, boolean, date, invalid, query, page, identifier } from './lib/runtime.js';

const fields = ['title', 'calendarId', 'startDate', 'endDate', 'allDay', 'timeZone', 'notes', 'location', 'url'];
export function eventInput(value, creating = false) {
  object(value, creating ? [...fields, 'idempotencyKey'] : fields);
  const input = {};
  for (const key of ['title', 'calendarId']) if (value[key] !== undefined) input[key] = string(value[key], key, key === 'title' ? 1000 : 4096);
  for (const key of ['notes', 'location', 'url']) if (Object.hasOwn(value, key)) input[key] = value[key] === null ? null : string(value[key], key, key === 'notes' ? 20000 : 4096, true);
  if (input.url) { try { const url = new URL(input.url); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); } catch { throw invalid('url must be an HTTP or HTTPS URL.'); } }
  for (const key of ['startDate', 'endDate']) if (value[key] !== undefined) input[key] = date(value[key], key);
  if (value.allDay !== undefined) input.allDay = boolean(value.allDay, 'allDay');
  if (value.timeZone !== undefined) {
    input.timeZone = string(value.timeZone, 'timeZone', 128);
    try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }); } catch { throw invalid('timeZone must be a valid IANA time zone.'); }
  }
  if (creating && (!input.title || !input.startDate || !input.endDate)) throw invalid('title, startDate and endDate are required.');
  if (input.startDate && input.endDate && Date.parse(input.endDate) <= Date.parse(input.startDate)) throw invalid('endDate must be after startDate.');
  if (!creating && !Object.keys(input).length) throw invalid('Provide at least one event field to update.');
  return input;
}
export function eventTarget(value) {
  const target = identifier(value);
  object(target, ['eventId', 'calendarId', 'startDate']);
  string(target.eventId, 'eventId', 4096); string(target.calendarId, 'calendarId', 4096); date(target.startDate, 'startDate');
  return target;
}
export function route(method, url, body, scope) {
  const params = ['pageSize', 'nextToken'];
  if (method === 'GET' && url.pathname === '/calendars') {
    query(url, params); const paging = page(url, 'local'); return { input: { operation: 'calendars', offset: paging.offset, limit: paging.limit }, page: paging };
  }
  if (url.pathname === '/events' && method === 'GET') {
    query(url, [...params, 'startDate', 'endDate', 'calendarId', 'query']);
    const startDate = date(url.searchParams.get('startDate'), 'startDate'), endDate = date(url.searchParams.get('endDate'), 'endDate');
    const range = Date.parse(endDate) - Date.parse(startDate);
    if (range <= 0 || range > 366 * 86400000) throw invalid('Event range must be positive and at most 366 days.');
    const paging = page(url, 'local'), calendarId = url.searchParams.get('calendarId'), search = url.searchParams.get('query');
    if (calendarId !== null) string(calendarId, 'calendarId', 4096);
    if (search !== null) string(search, 'query', 500);
    return { input: { operation: 'events', startDate, endDate, ...(calendarId ? { calendarId } : {}), ...(search ? { query: search } : {}), offset: paging.offset, limit: paging.limit }, page: paging };
  }
  query(url, []);
  if (url.pathname === '/events' && method === 'POST') {
    const input = eventInput(body, true);
    return { input: { ...input, operation: 'create' }, idempotencyKey: string(body.idempotencyKey, 'idempotencyKey', 128) };
  }
  const match = url.pathname.match(/^\/events\/([^/]+)$/);
  if (match && ['GET', 'PATCH', 'DELETE'].includes(method)) {
    const target = eventTarget(decodeURIComponent(match[1]));
    return { input: { ...(method === 'PATCH' ? eventInput(body) : {}), operation: { GET: 'get', PATCH: 'update', DELETE: 'delete' }[method], target } };
  }
}
const pagination = [
  { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } },
  { name: 'nextToken', in: 'query', schema: { type: 'string' } },
];
const eventSchema = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string' }, calendarId: { type: 'string' }, startDate: { type: 'string', format: 'date-time' }, endDate: { type: 'string', format: 'date-time', description: 'Exclusive end; must follow startDate.' },
  allDay: { type: 'boolean', default: false }, timeZone: { type: 'string', description: 'IANA time zone; defaults to this Mac’s zone. All-day events are floating and require this Mac’s zone.' }, notes: { type: 'string', nullable: true }, location: { type: 'string', nullable: true }, url: { type: 'string', nullable: true, format: 'uri' },
} };
const responses = { 200: { description: 'Native result' }, 400: { description: 'Invalid input' }, 403: { description: 'Calendar permission denied or calendar read-only' }, 404: { description: 'Event or calendar not found' }, 409: { description: 'Unsupported recurring event or uncertain mutation' } };
const json = schema => ({ required: true, content: { 'application/json': { schema } } });
export const openapi = { openapi: '3.0.3', info: { title: 'Apple Calendar', version: '1.0.0' }, paths: {
  '/calendars': { get: { operationId: 'listAppleCalendars', summary: 'List this Mac’s calendars and write permissions', parameters: pagination, responses } },
  '/events': {
    get: { operationId: 'listAppleCalendarEvents', summary: 'List event occurrences in a bounded date range', parameters: [...pagination, ...['startDate', 'endDate'].map(name => ({ name, in: 'query', required: true, schema: { type: 'string', format: 'date-time' } })), ...['calendarId', 'query'].map(name => ({ name, in: 'query', schema: { type: 'string' } }))], responses },
    post: { operationId: 'createAppleCalendarEvent', summary: 'Create a non-recurring event', requestBody: json({ ...eventSchema, required: ['title', 'startDate', 'endDate', 'idempotencyKey'], properties: { ...eventSchema.properties, idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 } } }), responses: { ...responses, 201: { description: 'Created event' } } },
  },
  '/events/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Opaque occurrence ID returned by this plugin.' }],
    get: { operationId: 'getAppleCalendarEvent', summary: 'Read one exact event occurrence', responses },
    patch: { operationId: 'updateAppleCalendarEvent', summary: 'Update a non-recurring event', requestBody: json(eventSchema), responses },
    delete: { operationId: 'deleteAppleCalendarEvent', summary: 'Delete a non-recurring event', responses },
  },
} };
export const definition = { authId: 'eventkit', authName: 'This Mac', frameworks: ['Foundation', 'EventKit'], openapi, route,
  connectInput: () => ({ operation: 'authorize' }), connected: () => ({ scope: { local: true }, account: { id: 'local', label: 'Calendar on this Mac' } }),
  validateScope(scope) { object(scope, ['local']); if (scope.local !== true) throw invalid('Invalid Calendar connection.'); },
};
export default function setup(ctx) { return createAdapter(ctx, definition); }
