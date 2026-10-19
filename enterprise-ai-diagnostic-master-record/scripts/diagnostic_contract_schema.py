"""Bounded stdlib validation for this package's checked-in contract schemas.

Supports the vocabulary used here, not the full JSON Schema specification.
References are local only; unsupported validation keywords fail closed.
"""
from datetime import datetime
import math
import re

KEYWORDS = {'$schema', '$id', '$defs', '$ref', 'title', 'description', 'type',
            'required', 'properties', 'additionalProperties', 'items', 'minItems',
            'minLength', 'minimum', 'pattern', 'format', 'enum', 'const', 'allOf',
            'if', 'then'}

def _type(value, name):
    return {'object': isinstance(value, dict), 'array': isinstance(value, list),
            'string': isinstance(value, str), 'integer': type(value) is int,
            'number': (type(value) is int or type(value) is float and math.isfinite(value)),
            'boolean': type(value) is bool, 'null': value is None}.get(name, False)

def _equal(left, right):
    # Python equates True and 1; JSON contracts must not.
    if type(left) is bool or type(right) is bool:
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_equal(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_equal(a, b) for a, b in zip(left, right))
    return left == right

def validate_schema(value, schema):
    """Return stable, value-free field errors; never fetch a schema or coerce data."""
    def resolve_ref(ref):
        if not isinstance(ref, str):
            return None, 'SCHEMA_REF_INVALID'
        if not ref.startswith('#/'):
            return None, 'SCHEMA_REF_UNSUPPORTED'
        target = schema
        try:
            for part in ref[2:].split('/'):
                target = target[part.replace('~1', '/').replace('~0', '~')]
        except (KeyError, TypeError):
            return None, 'SCHEMA_REF_INVALID'
        if not isinstance(target, dict):
            return None, 'SCHEMA_REF_INVALID'
        return target, None

    def definition_errors(rule, path):
        if not isinstance(rule, dict):
            return [f'SCHEMA_DEFINITION:{path}']
        errors = [f'SCHEMA_UNSUPPORTED:{path}/{key}' for key in sorted(set(rule) - KEYWORDS)]
        if 'format' in rule and rule['format'] != 'date-time':
            errors.append(f'SCHEMA_UNSUPPORTED:{path}/format')
        if 'additionalProperties' in rule and type(rule['additionalProperties']) is not bool:
            errors.append(f'SCHEMA_UNSUPPORTED:{path}/additionalProperties')
        if '$ref' in rule:
            _, ref_error = resolve_ref(rule['$ref'])
            if ref_error:
                errors.append(f'{ref_error}:{path}')
        for key in ('$defs', 'properties'):
            for name, child in rule.get(key, {}).items():
                errors.extend(definition_errors(child, f'{path}/{key}/{name}'))
        for key in ('items', 'if', 'then'):
            if key in rule:
                errors.extend(definition_errors(rule[key], f'{path}/{key}'))
        for index, child in enumerate(rule.get('allOf', [])):
            errors.extend(definition_errors(child, f'{path}/allOf/{index}'))
        return errors
    definitions = definition_errors(schema, '#')
    if definitions:
        return sorted(set(definitions))
    def visit(item, rule, path):
        errors = []
        unknown = set(rule) - KEYWORDS
        if unknown:
            return [f'SCHEMA_UNSUPPORTED:{path}/{key}' for key in sorted(unknown)]
        if '$ref' in rule:
            target, ref_error = resolve_ref(rule['$ref'])
            if ref_error:
                return [f'{ref_error}:{path}']
            errors.extend(visit(item, target, path))
        types = rule.get('type', [])
        if isinstance(types, str):
            types = [types]
        if types and not any(_type(item, name) for name in types):
            return errors + [f'SCHEMA_TYPE:{path}']
        if 'enum' in rule and not any(_equal(item, option) for option in rule['enum']):
            errors.append(f'SCHEMA_ENUM:{path}')
            if not any(type(item) is type(option) for option in rule['enum']):
                errors.append(f'SCHEMA_TYPE:{path}')
        if 'const' in rule and not _equal(item, rule['const']):
            errors.append(f'SCHEMA_CONST:{path}')
            if type(item) is not type(rule['const']):
                errors.append(f'SCHEMA_TYPE:{path}')
        for clause in rule.get('allOf', []):
            errors.extend(visit(item, clause, path))
        if 'if' in rule:
            condition_errors = visit(item, rule['if'], path)
            # Definition failures are never ordinary data-condition mismatches.
            schema_errors = [error for error in condition_errors if error.startswith(
                ('SCHEMA_REF_', 'SCHEMA_DEFINITION:', 'SCHEMA_UNSUPPORTED:'))]
            if schema_errors:
                errors.extend(schema_errors)
            elif not condition_errors:
                errors.extend(visit(item, rule.get('then', {}), path))
        if isinstance(item, dict):
            errors.extend(f'SCHEMA_REQUIRED:{path}.{key}' for key in rule.get('required', []) if key not in item)
            props = rule.get('properties', {})
            for key, child in item.items():
                if key in props:
                    errors.extend(visit(child, props[key], f'{path}.{key}'))
                elif rule.get('additionalProperties') is False:
                    errors.append(f'SCHEMA_ADDITIONAL:{path}.{key}')
        if isinstance(item, list):
            if len(item) < rule.get('minItems', 0):
                errors.append(f'SCHEMA_MIN_ITEMS:{path}')
            if 'items' in rule:
                for index, child in enumerate(item):
                    errors.extend(visit(child, rule['items'], f'{path}[{index}]'))
        if isinstance(item, str):
            if len(item) < rule.get('minLength', 0):
                errors.append(f'SCHEMA_MIN_LENGTH:{path}')
            if 'pattern' in rule and not re.search(rule['pattern'], item):
                errors.append(f'SCHEMA_PATTERN:{path}')
            if rule.get('format') == 'date-time':
                try:
                    date = datetime.fromisoformat(item.replace('Z', '+00:00').replace('z', '+00:00'))
                    if not re.search('[Tt]', item) or date.tzinfo is None:
                        raise ValueError
                except ValueError:
                    errors.append(f'SCHEMA_DATE_TIME:{path}')
        if type(item) in (int, float) and 'minimum' in rule and item < rule['minimum']:
            errors.append(f'SCHEMA_MINIMUM:{path}')
        return errors
    return sorted(set(visit(value, schema, '$')))
