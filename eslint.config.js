import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat config for the plugin.
 *
 * Rules stay deliberately small: correctness (undefined names, unused
 * variables, unreachable code) over style, so a formatting pass never buries a
 * real change in noise. `client.js` runs in the panel's module loader, not
 * Node, so it gets browser globals and `require`.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'market/**',
      'docs/**',
      'models/**',
      'locale/**',
      '.ai-for-memory/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['client.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, require: 'readonly' },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.builtin },
    },
  },
];
