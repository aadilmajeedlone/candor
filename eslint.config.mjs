// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const PROJECT = {
  main: './tsconfig.node.json',
  web: './tsconfig.web.json',
  e2e: './tsconfig.e2e.json',
};

const typed = (files, project, extra = {}) => ({
  files,
  languageOptions: { parserOptions: { project, tsconfigRootDir: import.meta.dirname } },
  ...extra,
});

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'build/**', 'coverage/**', 'bench-results/**', '.model-cache/**', 'resources/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // Which tsconfig describes which files (type-aware rules need the real compiler options, e.g. DOM lib in the renderer).
  typed(['src/renderer/**/*.{ts,tsx}'], PROJECT.web),
  typed(['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts', 'src/core/**/*.ts', 'src/prompts/**/*.ts', 'tests/unit/**/*.ts', 'tests/integration/**/*.ts', 'tests/bench/**/*.ts', 'tests/speech/**/*.ts', 'tests/local-llm/**/*.ts', 'tests/helpers/**/*.ts', 'tests/fixtures/**/*.ts', '*.config.ts'], PROJECT.main),
  typed(['tests/e2e/**/*.ts'], PROJECT.e2e),

  {
    rules: {
      // The bugs that bite an async, streaming app: forgotten awaits, promises in places that ignore them.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // A `default` branch is a legitimate way to say "every other mode/kind".
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true, allowNullish: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',

      // Injection and code-loading hazards.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Rendering raw HTML is not allowed. Render text through React.' },
        { selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]", message: 'Assigning HTML strings is not allowed. Build DOM through React.' },
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: 'Inserting HTML strings is not allowed.' },
      ],
    },
  },

  // The main process is where secrets live: no ad-hoc console output (use the redacting logger).
  {
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/logging.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/core/**/*.ts', 'src/shared/**/*.ts', 'scripts/**/*.{ts,mjs}', '*.config.ts', '*.config.mjs', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Handlers such as onClick={() => void save()} are fine; async functions passed where void is expected are not.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: true } }],
    },
  },

  // The audio worklet is plain JavaScript that runs in an AudioWorkletGlobalScope.
  {
    files: ['src/renderer/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', sampleRate: 'readonly', currentTime: 'readonly', currentFrame: 'readonly' } },
  },
  { files: ['**/*.{js,mjs,cjs}'], ...tseslint.configs.disableTypeChecked },

  // Tests poke at loosely-typed wire payloads and browser-side evaluate() callbacks.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-console': 'off',
    },
  },
);
