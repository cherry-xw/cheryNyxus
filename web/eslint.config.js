import tseslint from 'typescript-eslint'
import vuePlugin from 'eslint-plugin-vue'
import prettierPlugin from 'eslint-plugin-prettier'
import prettierConfig from 'eslint-config-prettier'
import vueParser from 'vue-eslint-parser'

export default tseslint.config(
  {
    ignores: ['dist/', 'dist-electron/', 'node_modules/'],
  },

  // Vue base rules
  ...vuePlugin.configs['flat/recommended'],

  // TypeScript rules
  ...tseslint.configs.recommended,

  // Prettier (must be last)
  prettierConfig,
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
    },
  },

  // Vue-specific: parser + rules
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
    },
    rules: {
      'vue/html-self-closing': [
        'error',
        {
          html: { void: 'always', normal: 'always', component: 'always' },
          svg: 'always',
          math: 'always',
        },
      ],
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/require-default-prop': 'off',
      'vue/no-v-html': 'off',
    },
  },

  // TS-specific overrides
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // Architecture boundaries. Public application/domain surfaces replace store internals.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vue', message: 'Domain modules must stay framework-free.' },
            { name: 'pinia', message: 'Domain modules must stay framework-free.' },
          ],
          patterns: [
            {
              group: ['@/application/**', '@/stores/**', '@/services/**', '@/features/**'],
              message:
                'Domain modules cannot depend on application, stores, infrastructure, or features.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/application/**',
                '@/stores/**',
                '@/features/**',
                '../application/**',
                '../stores/**',
                '../features/**',
              ],
              message: 'Services receive runtime state through injected ports and stay UI-free.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/stores/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/**', '../../features/**', '../features/**'],
              message: 'State owners cannot depend on UI feature implementations.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/stores/chats/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../agents/**', '@/stores/agents/**'],
              message: 'Chat is the canonical owner and must not depend on the legacy agents store.',
            },
            {
              group: ['@/features/**', '../../../features/**', '../../features/**'],
              message: 'The Chat state owner cannot depend on UI feature implementations.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/**/*.{ts,vue}'],
    ignores: ['src/features/pets/nyxus/application/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/stores', '@/stores/**', '@/services', '@/services/**'],
              message: 'Features must consume stable application/domain public ports.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/pets/nyxus/**/*.{ts,vue}'],
    ignores: ['src/features/pets/nyxus/application/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/stores', '@/stores/**'],
              message: 'Nyxus internals must use the NyxusHostPort adapter.',
            },
          ],
        },
      ],
    },
  },
)
