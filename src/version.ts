/**
 * Single source of truth for the server version. release-please rewrites the
 * literal on the marker line; every manifest that carries a version is kept in
 * sync from here (see `release-please-config.json` extra-files) or from this
 * constant, so nothing is hand-bumped.
 */
export const VERSION = '0.2.0'; // x-release-please-version
