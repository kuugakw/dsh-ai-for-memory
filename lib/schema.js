// @ts-check
/**
 * Minimal JSON Schema validator for the subset the plugin declares.
 *
 * Tool schemas (`lib/tools.js`) and MCP input schemas (`lib/mcp.js`) are the
 * contract the model sees. Without a runtime check they were documentation only:
 * a wrong type silently flowed into the handlers. This validator covers the
 * keywords those schemas actually use (type, enum, required, properties, items,
 * additionalProperties, minimum, maximum, minLength, maxLength, minItems,
 * maxItems); unknown keywords are ignored so adding a `description` never fails
 * a call.
 */

/** @typedef {any} JsonSchema */

/**
 * @param {JsonSchema} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} human-readable errors (empty = valid)
 */
export function validateValue(schema, value, path = '$') {
  /** @type {string[]} */
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (Object.hasOwn(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = valueType(value);
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number')) && !(actual === 'null' && types.includes('null'))) {
      errors.push(`${path} 应为 ${types.join(' | ')}（实际 ${actual}）`);
      return errors;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) {
    errors.push(`${path} 必须是 ${schema.enum.map((item) => JSON.stringify(item)).join(' / ')} 之一`);
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path} 至少 ${schema.minLength} 个字符`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path} 最多 ${schema.maxLength} 个字符`);
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path} 不能小于 ${schema.minimum}（实际 ${value}）`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path} 不能大于 ${schema.maximum}（实际 ${value}）`);
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path} 至少 ${schema.minItems} 项`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path} 最多 ${schema.maxItems} 项`);
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => {
        errors.push(...validateValue(schema.items, item, `${path}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} 是必填项`);
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key} 不是允许的参数`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      errors.push(...validateValue(childSchema, value[key], `${path}.${key}`));
    }
  }

  return errors;
}

/** @param {unknown} value @returns {string} */
function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Validate tool arguments and render one message for the model.
 *
 * @param {JsonSchema} schema
 * @param {unknown} args
 * @param {string} [label]
 * @returns {string} '' when valid, otherwise a bullet list
 */
export function validateArgumentsMessage(schema, args, label = '参数') {
  const errors = validateValue(schema, args ?? {}, '');
  if (errors.length === 0) return '';
  const cleaned = errors.map((error) => error.replace(/^\.+/, '') || '$');
  return `${label}校验失败：\n- ${cleaned.join('\n- ')}\n请修正参数后重试。`;
}
