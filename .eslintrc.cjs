module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  globals: {
    // Frida 全局变量
    Java: 'readonly',
    ObjC: 'readonly',
    Memory: 'readonly',
    Module: 'readonly',
    Process: 'readonly',
    Interceptor: 'readonly',
    NativeFunction: 'readonly',
    NativePointer: 'readonly',
    recv: 'readonly',
    send: 'readonly',
    rpc: 'readonly',
    Script: 'readonly',
  },
  extends: ['eslint:recommended'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    // TypeScript 相关 (简化版本)
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off', // Frida 环境中经常需要 any

    // 通用规则
    'no-console': 'off', // Frida 脚本中需要 console
    'no-debugger': 'warn',
    'prefer-const': 'error',
    'no-var': 'error',

    // 代码风格
    eqeqeq: ['error', 'always'],
    curly: ['error', 'all'],
    'brace-style': ['error', '1tbs'],
  },
  overrides: [
    {
      files: ['**/*.ts'],
      rules: {
        // TypeScript owns name resolution, including types such as NodeJS.
        'no-undef': 'off',
        'no-redeclare': 'off',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'warn',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
    {
      files: ['*.js'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    {
      files: ['scripts/**/*.js'],
      rules: {
        'no-console': 'off',
      },
    },
    {
      files: ['**/*.test.ts', '**/*.spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
