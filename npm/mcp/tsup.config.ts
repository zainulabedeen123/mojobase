import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/stdio/index.ts',
  },
  format: ['esm'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['@modelcontextprotocol/sdk', 'commander', 'node-fetch', 'zod', 'express', 'mixpanel'],
  clean: true,
});
