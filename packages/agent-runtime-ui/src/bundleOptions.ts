/**
 * Build settings that shape every compiled React UI bundle. React's production
 * build plus minification keeps a component at ~140 KB instead of the ~1 MB
 * unminified development build, which every view otherwise ships to the host
 * (and, on mobile, across the remote relay) and executes.
 *
 * The settings are attested as a generated build input: a component compiled
 * before they changed lacks the matching input and is treated as stale, so
 * live workspace renders rebuild once with the current settings.
 */
export const BUNDLE_OPTIONS_INPUT_PATH = 'marshal-bundle-options.json';

export const BUNDLE_BUILD_OPTIONS = Object.freeze({
  define: Object.freeze({ 'process.env.NODE_ENV': '"production"' }),
  minify: true,
});

export const BUNDLE_OPTIONS_CONTENTS = JSON.stringify({
  schemaVersion: 1,
  nodeEnv: 'production',
  minify: BUNDLE_BUILD_OPTIONS.minify,
});
