import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      'packages/desktop-app/renderer/**',
      'packages/desktop-app/bridge-runtime/**',
      'packages/mobile-app/android/**',
      'packages/mobile-app/ios/**',
      'packages/mobile-app/public/downloads/**',
    ],
  },
  js.configs.recommended,
  {
    files: [
      'packages/shared/src/**/*.js',
      'packages/relay-server/src/**/*.js',
      'packages/dsh-mobile-hub/**/*.js',
      'packages/desktop-app/src/**/*.js',
      'packages/desktop-app/scripts/**/*.mjs',
      'packages/mobile-app/scripts/**/*.mjs',
      'packages/mobile-app/vite.config.js',
      'scripts/**/*.mjs',
      'tests/**/*.mjs',
      'eslint.config.mjs',
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
        __ALLINONE_VERSION__: 'readonly',
        __ALLINONE_DEFAULT_SERVER__: 'readonly',
        __ALLINONE_DSH_IPC_PLUGIN_CODE__: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-control-regex': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['packages/desktop-app/scripts/**/*.cjs', 'packages/desktop-app/src/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['packages/relay-server/src/admin/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.es2024,
      },
    },
  },
  {
    files: ['packages/mobile-app/src/**/*.{js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2024,
        __APP_VERSION__: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^([A-Z_]|_)',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-control-regex': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
]
