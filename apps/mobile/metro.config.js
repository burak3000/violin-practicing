// Learn more https://docs.expo.dev/guides/monorepos
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * packages/core and packages/dsp-ts use TypeScript's `NodeNext`-style
 * relative imports (e.g. `import ... from './clamp.js'` inside a file
 * that is actually `clamp.ts`) -- required by their own tsconfig's
 * `moduleResolution: "NodeNext"` (see packages/core/tsconfig.json), and
 * already correctly handled by both `tsc` itself and apps/desktop's
 * Vite/esbuild-based bundler (esbuild understands this convention
 * natively, mapping an explicit `.js` specifier back to the sibling
 * `.ts` source file).
 *
 * Metro's default resolver does NOT do this: an explicit `.js`/`.jsx`
 * extension is treated as a literal filename request, so it never falls
 * back to trying `.ts`/`.tsx` the way it does for extension-less imports.
 * This was discovered during Phase 4 because apps/mobile is the FIRST
 * Metro-bundled target in this repo to ever import `@violin/core` at all
 * (`npx expo export --platform all` failed with "Unable to resolve module
 * ./clamp.js from packages/core/src/index.ts") -- a latent incompatibility
 * between two already-existing, already-validated packages and this app's
 * bundler, not something introduced by react-native-audio-api or this
 * phase's own new code. See apps/mobile/CLAUDE.md's "Metro + NodeNext
 * `.js` imports" section for the full writeup.
 *
 * Fix: when Metro's own default resolution fails for a relative `./x.js`
 * (or `.jsx`) import, retry once with the extension stripped so Metro's
 * normal `sourceExts` search (which includes `ts`/`tsx`) gets a chance to
 * find `./x.ts` instead. Scoped as narrowly as possible: the fallback only
 * runs after the default resolver already threw, and only rewrites
 * relative specifiers ending in `.js`/`.jsx` -- every other import
 * (including any *working* literal `.js` file) resolves via the first,
 * unmodified `context.resolveRequest` call and never reaches the catch
 * branch at all.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    const isRelativeJsImport =
      /\.jsx?$/.test(moduleName) && (moduleName.startsWith('./') || moduleName.startsWith('../'));
    if (!isRelativeJsImport) {
      throw error;
    }
    const withoutExtension = moduleName.replace(/\.jsx?$/, '');
    return context.resolveRequest(context, withoutExtension, platform);
  }
};

module.exports = config;
