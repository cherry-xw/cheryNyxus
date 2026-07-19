import tseslint from 'typescript-eslint'
import prettierPlugin from 'eslint-plugin-prettier'
import prettierConfig from 'eslint-config-prettier'

export default tseslint.config(
  // Base ignores
  {
    ignores: ['dist/', 'node_modules/', 'web/', '.chery/', '*.js'],
  },

  // TypeScript files
  ...tseslint.configs.recommended,

  // Prettier integration (must be last)
  prettierConfig,
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
    },
  },

  // Project-specific overrides
  {
    files: ['src/**/*.ts'],
    rules: {
      // TSC already handles these with stricter settings
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
)
