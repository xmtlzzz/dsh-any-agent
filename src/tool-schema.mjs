/** Validate the JSON Schema keywords used by the built-in tool definitions. */
const matchesType = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  number: Number.isFinite,
  integer: Number.isInteger,
  null: (value) => value === null,
};

export function isObject(value) {
  return matchesType.object(value);
}

export function schemaIssue(schema, value, path) {
  if (!schema) return null;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !types.some((type) => matchesType[type]?.(value))) return `${path} must be ${types.join(' or ')}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (schema.maxLength !== undefined && Array.from(value).length > schema.maxLength) {
    return `${path} exceeds ${schema.maxLength} characters`;
  }
  if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      const issue = schemaIssue(schema.items, item, `${path}[${index}]`);
      if (issue) return issue;
    }
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    }
    for (const [key, item] of Object.entries(value)) {
      const props = schema.properties ?? {};
      if (!Object.hasOwn(props, key)) {
        if (schema.additionalProperties === false) return `${path} contains an unknown property`;
        continue;
      }
      const issue = schemaIssue(props[key], item, `${path}.${key}`);
      if (issue) return issue;
    }
  }
  return null;
}
