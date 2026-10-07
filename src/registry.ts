import cinejoy from "./providers/cinejoy.js";
import sevenMovies from "./providers/7movies.js";
import movienight from "./providers/movienight.js";
import type { Provider } from "./providers/_template.js";

/**
 * The literal map. One line per provider — this is the ONLY file that knows
 * all providers exist (dynamic template imports are provably untypeable in TS,
 * so this map is what keeps the build honest). No barrel over providers/.
 */
export const ALL = {
  cinejoy,
  "7movies": sevenMovies,
  movienight,
} satisfies Record<string, Provider>;

export type SiteId = keyof typeof ALL;

/* Fail-closed enablement: a provider not listed here is OFF. One line is the kill-switch. */
export const ENABLED: SiteId[] = ["cinejoy", "7movies", "movienight"];
