import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
	globalIgnores(['node_modules', 'runs', 'data', 'scratch']),
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts', '**/*.js'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
);
