if (process.argv[2] !== 'run' || process.argv[3] !== 'marshal:install') {
  process.exit(23);
}

await import('./build.mjs');
