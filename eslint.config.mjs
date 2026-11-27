import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: ['.next/**', '.test-dist/**', '.server-dist/**', 'node_modules/**'],
  },
];

export default eslintConfig;
