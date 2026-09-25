import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const NUMERIC_PARSE_MESSAGE =
  'Numeric strings are parsed only at the border (src/core/schema.ts) with decimal.js or bigint.';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'data', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Guardrail for trap #1: parseFloat/parseInt silently lose precision or truncate.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: NUMERIC_PARSE_MESSAGE },
        { name: 'parseInt', message: NUMERIC_PARSE_MESSAGE },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: NUMERIC_PARSE_MESSAGE },
        { object: 'Number', property: 'parseInt', message: NUMERIC_PARSE_MESSAGE },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
