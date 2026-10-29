import { build } from 'esbuild';

await build({
  entryPoints: ['packages/loader/index.ts'],
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  sourcemap: 'inline',
  outfile: 'dist/bundle.js',
  legalComments: 'none',
  treeShaking: true,
  target: 'es2020',
  minify: process.env.NODE_ENV === 'production',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
  },
  external: ['fs', 'path', 'crypto'],
  plugins: [
    {
      name: 'build-logger',
      setup(currentBuild) {
        currentBuild.onStart(() => {
          console.log('Building Frida bundle...');
        });

        currentBuild.onEnd(result => {
          if (result.errors.length > 0) {
            console.error('Build failed with errors:');
            result.errors.forEach(error => console.error(error));
            return;
          }

          console.log('Build completed successfully.');
          console.log(`Bundle size: ${result.metafile ? 'check metafile output' : 'unknown'}`);
        });
      },
    },
  ],
  metafile: true,
  logLevel: 'info',
});

console.log('Bundle saved to: dist/bundle.js');
