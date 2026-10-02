import { json, err, run, requireAuth } from '../../src/api/http';
import { optionalEnv } from '../../src/lib/config';

/**
 * GET /api/geo/search?q=<texte>&limit=<1-8>  (tout compte authentifié)
 *
 * Proxy Geoapify (étape 6) — l'autocomplétion d'adresse de la résidence ne
 * part plus du navigateur :
 *  - la clé est dans l'env Vercel (`GEOAPIFY_API_KEY`), JAMAIS dans le code
 *    ni dans la réponse (l'ancienne clé du fichier HTML d'origine doit être
 *    considérée comme divulguée et révoquée) ;
 *  - HTTPS forcé (endpoint en https, rien d'autre n'est tenté) ;
 *  - restreint au Bénin (`filter=countrycode:bj`) et en français, comme
 *    l'autocomplétion d'origine.
 *
 * Sans clé configurée : 503 explicite — le front retombe sur la saisie
 * manuelle (la saisie reste toujours possible, l'autocomplétion est un
 * confort).
 */

const GEO_ENDPOINT = 'https://api.geoapify.com/v1/geocode/autocomplete';

type FetchLike = (url: string, init?: any) => Promise<Response>;
let _fetch: FetchLike = fetch as FetchLike;

/** SEAM DE TEST : remplace la couche HTTP du proxy (jamais utilisée en prod). */
export function __setGeoFetchForTests(f: FetchLike): void {
  _fetch = f;
}
export function __resetGeoFetchForTests(): void {
  _fetch = fetch as FetchLike;
}

export default run(async (req: Request) => {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  if (req.method !== 'GET') return err('Méthode non autorisée.', 405);

  const url = new URL(req.url);
  const q = String(url.searchParams.get('q') ?? '').trim();
  const limitRaw = parseInt(url.searchParams.get('limit') || '6', 10);
  const limit = Math.min(8, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 6));
  if (q.length < 2) return err('Recherche trop courte (2 caractères minimum).', 400);
  if (q.length > 120) return err('Recherche trop longue (120 caractères max).', 400);

  const apiKey = optionalEnv('GEOAPIFY_API_KEY');
  if (!apiKey) {
    return err("Autocomplétion indisponible : clé Geoapify non configurée (variable d'environnement GEOAPIFY_API_KEY).", 503);
  }

  // HTTPS uniquement ; la clé ne voyage que vers l'amont, jamais dans la réponse.
  const upstream =
    GEO_ENDPOINT +
    '?text=' + encodeURIComponent(q) +
    '&filter=countrycode:bj' +
    '&lang=fr' +
    '&format=json' +
    '&apiKey=' + encodeURIComponent(apiKey);

  let res: Response;
  try {
    res = await _fetch(upstream);
  } catch {
    return err('Service de géocodage inaccessible.', 502);
  }
  if (!res.ok) {
    return err(`Service de géocodage indisponible (HTTP ${res.status}).`, 502);
  }
  const data = (await res.json().catch(() => null)) as { results?: unknown } | null;
  const rawResults = Array.isArray(data?.results) ? (data.results as Record<string, any>[]) : [];
  // Seuls les champs consommés par le front (identiques à l'app d'origine).
  const results = rawResults.slice(0, limit).map((r) => ({
    formatted: String(r.formatted || ''),
    city: r.city != null && r.city !== '' ? String(r.city) : null,
    state: r.state != null && r.state !== '' ? String(r.state) : null,
    county: r.county != null && r.county !== '' ? String(r.county) : null,
    lat: typeof r.lat === 'number' ? r.lat : null,
    lon: typeof r.lon === 'number' ? r.lon : null,
  }));
  return json({ results });
});
