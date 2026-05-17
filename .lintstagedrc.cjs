// lint-staged config in .cjs function form so the returned command
// runs WITHOUT lint-staged auto-appending the matched file paths.
//
// Why this matters on Windows: the default config-object form passes
// every staged file as a positional arg to biome. Large commits blow
// past the Windows CMD command-line limit (~8 KB) and the pre-commit
// hook fails with "Die Befehlszeile ist zu lang."
//
// Biome 2.x has its own --staged flag that reads the git index
// directly, so we delegate file discovery to biome and ignore the
// file list lint-staged passes us.
module.exports = {
  '*.{ts,tsx,js,jsx,json}': () => 'biome check --write --no-errors-on-unmatched --staged',
};
