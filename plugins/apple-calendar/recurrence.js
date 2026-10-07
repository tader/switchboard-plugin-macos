import { object, date, invalid } from './lib/runtime.js';
const frequencies = ['daily', 'weekly', 'monthly', 'yearly'];
const arrayFields = { daysOfTheMonth: 31, monthsOfTheYear: 12, weeksOfTheYear: 53, daysOfTheYear: 366, setPositions: 366 };
function integer(value, name, min, max, nonzero = false) {
  if (!Number.isInteger(value) || value < min || value > max || (nonzero && value === 0)) throw invalid(`${name} must be an integer from ${min} to ${max}${nonzero ? ', excluding zero' : ''}.`);
  return value;
}
export function recurrenceInput(value) {
  if (value === null) return null;
  object(value, ['frequency', 'interval', 'daysOfTheWeek', ...Object.keys(arrayFields), 'end']);
  if (!frequencies.includes(value.frequency)) throw invalid('recurrence.frequency must be daily, weekly, monthly or yearly.');
  const result = { frequency: value.frequency, interval: integer(value.interval ?? 1, 'recurrence.interval', 1, 1000) };
  const array = (items, name, max) => {
    if (!Array.isArray(items) || !items.length || items.length > max) throw invalid(`${name} must be a nonempty array with at most ${max} values.`);
  };
  if (value.daysOfTheWeek !== undefined) {
    if (value.frequency === 'daily') throw invalid('daysOfTheWeek is not supported for daily recurrence.');
    array(value.daysOfTheWeek, 'daysOfTheWeek', 366);
    result.daysOfTheWeek = value.daysOfTheWeek.map(day => {
      object(day, ['dayOfTheWeek', 'weekNumber']);
      const max = value.frequency === 'weekly' ? 0 : value.frequency === 'monthly' ? 5 : 53;
      return { dayOfTheWeek: integer(day.dayOfTheWeek, 'dayOfTheWeek', 1, 7), weekNumber: integer(day.weekNumber ?? 0, 'weekNumber', -max, max) };
    });
    const keys = result.daysOfTheWeek.map(day => `${day.dayOfTheWeek}:${day.weekNumber}`);
    if (new Set(keys).size !== keys.length) throw invalid('daysOfTheWeek must not contain duplicates.');
  }
  for (const [key, max] of Object.entries(arrayFields)) if (value[key] !== undefined) {
    if (key === 'daysOfTheMonth' && value.frequency !== 'monthly') throw invalid('daysOfTheMonth requires monthly recurrence.');
    if (['monthsOfTheYear', 'weeksOfTheYear', 'daysOfTheYear'].includes(key) && value.frequency !== 'yearly') throw invalid(`${key} requires yearly recurrence.`);
    array(value[key], key, max * 2);
    result[key] = value[key].map(item => integer(item, key, key === 'monthsOfTheYear' ? 1 : -max, max, true));
    if (new Set(result[key]).size !== result[key].length) throw invalid(`${key} must not contain duplicates.`);
  }
  if (result.setPositions && !['daysOfTheWeek', 'daysOfTheMonth', 'monthsOfTheYear', 'weeksOfTheYear', 'daysOfTheYear'].some(key => result[key])) throw invalid('setPositions requires another recurrence filter.');
  if (value.end !== undefined && value.end !== null) {
    object(value.end, ['date', 'count']);
    if (Object.keys(value.end).length !== 1) throw invalid('recurrence.end must have exactly one of date or count.');
    result.end = value.end.date !== undefined ? { date: date(value.end.date, 'recurrence.end.date') } : { count: integer(value.end.count, 'recurrence.end.count', 1, 100000) };
  }
  return result;
}
export function eventSpan(value) {
  if (!['thisEvent', 'futureEvents'].includes(value)) throw invalid('span must be thisEvent or futureEvents.');
  return value;
}
const numberArray = (min, max) => ({ type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: min, maximum: max, not: { enum: [0] } } });
export const recurrenceSchema = { type: 'object', nullable: true, additionalProperties: false, required: ['frequency'], description: 'Replace the recurrence rule; null removes recurrence. Omit to preserve existing rules. Ordinal weekdays require monthly/yearly frequency. Negative numbers count from the end of the period. Date ends are inclusive.', properties: {
  frequency: { type: 'string', enum: frequencies }, interval: { type: 'integer', minimum: 1, maximum: 1000, default: 1 },
  daysOfTheWeek: { type: 'array', minItems: 1, maxItems: 366, uniqueItems: true, items: { type: 'object', additionalProperties: false, required: ['dayOfTheWeek'], properties: { dayOfTheWeek: { type: 'integer', minimum: 1, maximum: 7, description: 'Sunday=1, Monday=2, … Saturday=7.' }, weekNumber: { type: 'integer', minimum: -53, maximum: 53, default: 0, description: '0 means every matching weekday; monthly ordinals are bounded to ±5; weekly requires 0.' } } } },
  daysOfTheMonth: numberArray(-31, 31), monthsOfTheYear: numberArray(1, 12), weeksOfTheYear: numberArray(-53, 53), daysOfTheYear: numberArray(-366, 366), setPositions: numberArray(-366, 366),
  end: { type: 'object', nullable: true, additionalProperties: false, oneOf: [{ required: ['date'] }, { required: ['count'] }], properties: { date: { type: 'string', format: 'date-time' }, count: { type: 'integer', minimum: 1, maximum: 100000 } } },
} };
export const spanSchema = { type: 'string', enum: ['thisEvent', 'futureEvents'], description: 'Required for recurring events. thisEvent changes only the selected occurrence; futureEvents changes it and later occurrences, preserving earlier ones. Detached occurrences require thisEvent. Use the first occurrence with futureEvents to affect an entire series.' };
