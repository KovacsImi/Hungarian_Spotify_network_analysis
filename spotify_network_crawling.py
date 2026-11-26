import asyncio
import random
import sqlite3
from collections.abc import Awaitable, Callable, Iterable
from typing import Any, TypeVar

from spotapi import Catalogue
from spotapi.operations import Operations
from spotapi.types import BaseClientError, HTTPError

from export_gephi_csv import export_gephi_csv

_T = TypeVar("_T")
_TRANSIENT_ERROR_MARKERS = (
    "subrequest_http_error",
    "connection closed",
    "timed out",
    "timeout",
    "temporarily unavailable",
    "returned no object data",
    "empty response body",
)


def is_transient_spotapi_error(exc: BaseException) -> bool:
    """Eldönti, hogy a spotapi hiba átmeneti szerveroldali/hálózati hiba-e (újrapróbálható)."""
    if isinstance(exc, HTTPError):
        return exc.status_code is None or exc.status_code in {408, 425, 429, 500, 502, 503, 504}
    if isinstance(exc, BaseClientError):
        msg = str(exc).lower()
        return any(marker in msg for marker in _TRANSIENT_ERROR_MARKERS)
    return isinstance(exc, (TimeoutError, ConnectionError))


async def call_with_retry(
    factory: Callable[[], Awaitable[_T]],
    *,
    max_retries: int = 3,
    base_delay: float = 0.75,
) -> _T:
    """Újrapróbálja az átmeneti Pathfinder/hálózati hibákat exponenciális visszalépéssel."""
    for attempt in range(max_retries):
        try:
            return await factory()
        except BaseException as exc:
            if attempt == max_retries - 1 or not is_transient_spotapi_error(exc):
                raise
            delay = base_delay * (2**attempt) + random.uniform(0.05, 0.35)
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")


def init_db(db_name: str = "spotify_artist_graph.db") -> sqlite3.Connection:
    """Létrehozza a helyi SQLite adatbázis tábláit és bekapcsolja a gyors WAL módot."""
    conn = sqlite3.connect(db_name)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS artists (
            artist_id TEXT PRIMARY KEY,
            uri TEXT UNIQUE,
            name TEXT,
            monthly_listeners INTEGER,
            image_url TEXT,
            crawled INTEGER DEFAULT 0
        )
        """
    )
    cols = {row[1] for row in conn.execute("PRAGMA table_info(artists)").fetchall()}
    if "image_url" not in cols:
        conn.execute("ALTER TABLE artists ADD COLUMN image_url TEXT")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS edges (
            source_id TEXT,
            target_id TEXT,
            rank INTEGER,
            weight REAL,
            PRIMARY KEY (source_id, target_id)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)")
    conn.commit()
    return conn


def pick_artist_image(sources: Any, min_size: int = 160) -> str | None:
    """Kiválasztja a legmegfelelőbb (alapból 160px+) előadói profilkép URL-t."""
    if not isinstance(sources, list):
        return None
    valid: list[tuple[int, str]] = []
    for item in sources:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url:
            continue
        width = item.get("width")
        w = width if isinstance(width, int) and not isinstance(width, bool) else 0
        valid.append((w, url))
    if not valid:
        return None
    ge_min = [pair for pair in valid if pair[0] >= min_size]
    if ge_min:
        return min(ge_min, key=lambda x: x[0])[1]
    return max(valid, key=lambda x: x[0])[1]


def extract_overview_fields(union: dict[str, Any]) -> tuple[str | None, int | None, str | None]:
    """Kinyeri az artistUnion objektumból a nevet, havi hallgatószámot és kép URL-t."""
    profile = union.get("profile") or {}
    raw_name = profile.get("name")
    name = raw_name if isinstance(raw_name, str) and raw_name else None

    stats = union.get("stats") or {}
    raw_listeners = stats.get("monthlyListeners")
    listeners = (
        raw_listeners
        if isinstance(raw_listeners, int) and not isinstance(raw_listeners, bool)
        else None
    )

    visuals = union.get("visuals") or {}
    avatar = visuals.get("avatarImage") or {}
    image_url = pick_artist_image(avatar.get("sources"))
    return name, listeners, image_url


def extract_id(uri: str) -> str:
    return uri.rsplit(":", 1)[-1]


def safe_get_name(obj: Any, fallback: str = "Ismeretlen") -> str:
    name = getattr(obj, "name", None)
    if isinstance(name, str) and name:
        return name
    profile = getattr(obj, "profile", None)
    profile_name = getattr(profile, "name", None) if profile is not None else None
    if isinstance(profile_name, str) and profile_name:
        return profile_name
    return fallback


def parse_related_tuple(rel_res: Any) -> list[tuple[str, str]]:
    """Feldolgozza a Catalogue.get_related_artists által visszaadott ArtistRelatedArtist tuple-t."""
    if not rel_res or not isinstance(rel_res, (tuple, list)):
        return []

    parsed: list[tuple[str, str]] = []
    for item in rel_res:
        uri = getattr(item, "uri", None)
        if not isinstance(uri, str) or not uri:
            continue
        parsed.append((uri, safe_get_name(item)))
    return parsed


def parse_overview_related(union: dict[str, Any]) -> list[tuple[str, str]]:
    """Tartalék kinyerés az artistUnion.relatedContent.relatedArtists listából."""
    related_content = union.get("relatedContent") or {}
    related_artists = related_content.get("relatedArtists") or {}
    items = related_artists.get("items") or []
    parsed: list[tuple[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        uri = item.get("uri")
        if not isinstance(uri, str) or not uri:
            continue
        profile = item.get("profile") or {}
        name = profile.get("name") or "Ismeretlen"
        parsed.append((uri, name))
    return parsed


async def fetch_overview_raw(spotify: Catalogue, uri: str) -> dict[str, Any]:
    """Nyers GraphQL lekérdezés retry-val: elkerüli a nehéz ArtistDetails/biography típusvalidációt."""
    res = await call_with_retry(
        lambda: spotify.queries.query(
            Operations.QUERY_ARTIST_OVERVIEW.value,
            {
                "uri": uri,
                "locale": "",
                "preReleaseV2": False,
                "includeMusicVideoPreviews": False,
            },
        )
    )
    if not res:
        return {}
    return res.get("artistUnion") or {}


async def fetch_artist_full(
    spotify: Catalogue,
    uri: str,
    sem: asyncio.Semaphore,
) -> tuple[str, dict[str, Any] | None]:
    """Párhuzamosan lekéri az előadó profiladatait (havi hallgatószám) és a 40 kapcsolódó előadót."""
    async with sem:
        overview_task = fetch_overview_raw(spotify, uri)
        related_task = call_with_retry(lambda: spotify.get_related_artists(uri))
        overview_res, rel_res = await asyncio.gather(
            overview_task, related_task, return_exceptions=True
        )

    overview_ok = not isinstance(overview_res, BaseException)
    related_ok = not isinstance(rel_res, BaseException)

    if not overview_ok and not related_ok:
        print(f"Hiba ({uri}): overview={overview_res!r} | related={rel_res!r}")
        return uri, None

    union = overview_res if overview_ok and isinstance(overview_res, dict) else {}
    name, monthly_listeners, image_url = extract_overview_fields(union)

    related: list[tuple[str, str]]
    complete: bool
    if related_ok:
        related = parse_related_tuple(rel_res)
        complete = overview_ok
    else:
        print(f"Figyelem ({uri}) get_related_artists hiba: {rel_res}")
        if (
            overview_ok
            and isinstance(rel_res, BaseClientError)
            and not is_transient_spotapi_error(rel_res)
        ):
            # Ha Spotify valóban nem ad relatedArtists kollekciót ezen a végponton, megpróbáljuk az overview-ból.
            related = parse_overview_related(union)
            complete = True
        else:
            # Átmeneti HTTP/Pathfinder hiba: ne jelöljük crawled=1-re, hogy újrafutáskor pótolható legyen.
            related = []
            complete = False

    return uri, {
        "name": name,
        "monthly_listeners": monthly_listeners,
        "image_url": image_url,
        "related": related,
        "complete": complete,
    }


async def fetch_listeners_only(
    spotify: Catalogue,
    uri: str,
    sem: asyncio.Semaphore,
) -> tuple[str, tuple[str | None, int | None, str | None] | None]:
    """Csak az előadó nevét, havi hallgatószámát és kép URL-jét kéri le (perem-célcsúcsok dúsításához)."""
    async with sem:
        try:
            union = await fetch_overview_raw(spotify, uri)
        except Exception as exc:
            print(f"Hallgatószám lekérési hiba ({uri}): {exc}")
            return uri, None

    if not union:
        return uri, None

    return uri, extract_overview_fields(union)


async def resolve_seeds(
    spotify: Catalogue,
    conn: sqlite3.Connection,
    seed_names: Iterable[str],
) -> list[tuple[str, str]]:
    """Feloldja a kezdő előadókat először a helyi DB-ből, majd párhuzamos Spotify előadó-kereséssel."""
    cur = conn.cursor()
    resolved: list[tuple[str, str]] = []
    missing_names: list[str] = []

    for raw_name in seed_names:
        cur.execute(
            "SELECT uri, name FROM artists WHERE LOWER(name) = LOWER(?)",
            (raw_name,),
        )
        row = cur.fetchone()
        if row and row[0]:
            uri, db_name = row[0], row[1] or raw_name
            resolved.append((uri, db_name))
            print(f"Kezdőpont betöltve DB-ből: {db_name} ({uri})")
        else:
            missing_names.append(raw_name)

    if missing_names:
        search_tasks = [
            spotify.search(name, types="artist", limit=5) for name in missing_names
        ]
        search_results = await asyncio.gather(*search_tasks, return_exceptions=True)

        for query_name, res in zip(missing_names, search_results):
            if isinstance(res, BaseException):
                print(f"Keresési hiba ({query_name}): {res}")
                continue
            artists = getattr(res, "artists", None) or []
            if not artists:
                print(f"Nem található kezdő előadó: {query_name}")
                continue

            chosen = artists[0]
            for candidate in artists:
                if safe_get_name(candidate, "").lower() == query_name.lower():
                    chosen = candidate
                    break

            artist_name = safe_get_name(chosen, fallback=query_name)
            resolved.append((chosen.uri, artist_name))
            print(f"Kezdőpont hozzáadva: {artist_name} ({chosen.uri})")

    # Deduplikáció sorrendmegtartással
    seen: set[str] = set()
    unique_resolved: list[tuple[str, str]] = []
    for uri, name in resolved:
        if uri not in seen:
            seen.add(uri)
            unique_resolved.append((uri, name))
    return unique_resolved


def chunked(items: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


async def crawl_network(
    seed_names: list[str],
    max_depth: int = 2,
    concurrency: int = 6,
    batch_size: int = 50,
    db_name: str = "spotify_artist_graph.db",
    recrawl: bool = False,
    enrich_border_nodes: bool = False,
    export_csv: bool = True,
) -> None:
    """Bejárja a Spotify előadói kapcsolati hálót max_depth mélységig (a depth == max_depth peremcsúcsok kapcsolataival együtt).

    Args:
        seed_names: Kiinduló előadók nevei.
        max_depth: Maximális bejárási mélység (0-tól max_depth-ig minden szint kapcsolatai le lesznek kérve).
        concurrency: Egyidejű HTTP kérések száma.
        batch_size: Ennyi előadónként történik adatbázis-mentés (commit).
        db_name: SQLite adatbázisfájl neve.
        recrawl: Ha True, a korábban crawled=1 előadókat is újra lekéri (pl. 20 -> 40 kapcsolat frissítéséhez).
        enrich_border_nodes: Ha True, a max_depth szint után felfedezett (depth == max_depth + 1)
            célcsúcsoknak is lekéri a havi hallgatószámát.
        export_csv: Ha True, a futás végén legenerálja a nodes.csv és edges.csv fájlokat.
    """
    conn = init_db(db_name)
    sem = asyncio.Semaphore(concurrency)

    try:
        cur = conn.cursor()
        if recrawl:
            crawled_uris: set[str] = set()
        else:
            cur.execute("SELECT uri FROM artists WHERE crawled = 1")
            crawled_uris = {row[0] for row in cur.fetchall() if row[0]}

        async with Catalogue() as spotify:
            seeds = await resolve_seeds(spotify, conn, seed_names)
            if not seeds:
                print("Nincs érvényes kiinduló előadó.")
                return

            cur.executemany(
                "INSERT OR IGNORE INTO artists (artist_id, uri, name) VALUES (?, ?, ?)",
                [(extract_id(uri), uri, name) for uri, name in seeds],
            )
            conn.commit()

            current_level_uris: set[str] = {uri for uri, _ in seeds}
            visited_uris: set[str] = set()

            # 0-tól max_depth-ig (inkluzív!): a depth == max_depth peremcsúcsok kapcsolatai is kellenek.
            for depth in range(max_depth + 1):
                if not current_level_uris:
                    break

                visited_uris.update(current_level_uris)
                next_level_uris: set[str] = set()

                to_fetch = [u for u in current_level_uris if u not in crawled_uris]
                already_done = [u for u in current_level_uris if u in crawled_uris]

                # Ha már crawled=1 és még megyünk mélyebbre, a mentett szomszédait töltjük be.
                if already_done and depth < max_depth:
                    done_ids = [extract_id(u) for u in already_done]
                    for id_chunk in chunked(done_ids, 900):
                        placeholders = ",".join("?" * len(id_chunk))
                        cur.execute(
                            f"""
                            SELECT DISTINCT a.uri FROM edges e
                            JOIN artists a ON e.target_id = a.artist_id
                            WHERE e.source_id IN ({placeholders})
                            """,
                            id_chunk,
                        )
                        for (target_uri,) in cur.fetchall():
                            if target_uri and target_uri not in visited_uris:
                                next_level_uris.add(target_uri)

                if to_fetch:
                    print(
                        f"\n--- Mélység {depth}/{max_depth}: {len(to_fetch)} előadó lekérése "
                        f"(concurrency={concurrency}) ---"
                    )
                    for batch_uris in chunked(to_fetch, batch_size):
                        tasks = [fetch_artist_full(spotify, uri, sem) for uri in batch_uris]
                        results = await asyncio.gather(*tasks)

                        discovered_artists: list[tuple[str, str, str]] = []
                        artist_upserts: list[tuple[str, str, str | None, int | None, str | None, int]] = []
                        complete_source_ids: list[tuple[str]] = []
                        edge_inserts: list[tuple[str, str, int, float]] = []

                        for uri, data in results:
                            if not data:
                                continue

                            src_id = extract_id(uri)
                            is_complete = bool(data["complete"])
                            artist_upserts.append(
                                (
                                    src_id,
                                    uri,
                                    data["name"],
                                    data["monthly_listeners"],
                                    data["image_url"],
                                    1 if is_complete else 0,
                                )
                            )
                            if is_complete:
                                crawled_uris.add(uri)

                            related = data["related"]
                            total = len(related)
                            if is_complete:
                                complete_source_ids.append((src_id,))

                            if total > 0:
                                for rank, (rel_uri, rel_name) in enumerate(related, start=1):
                                    rel_id = extract_id(rel_uri)
                                    weight = round((total - rank + 1) / total, 4)
                                    discovered_artists.append((rel_id, rel_uri, rel_name))
                                    edge_inserts.append((src_id, rel_id, rank, weight))
                                    if depth < max_depth and rel_uri not in visited_uris:
                                        next_level_uris.add(rel_uri)

                        if discovered_artists:
                            cur.executemany(
                                """
                                INSERT INTO artists (artist_id, uri, name)
                                VALUES (?, ?, ?)
                                ON CONFLICT(artist_id) DO UPDATE SET
                                    name = COALESCE(NULLIF(artists.name, 'Ismeretlen'), excluded.name)
                                """,
                                discovered_artists,
                            )

                        if artist_upserts:
                            cur.executemany(
                                """
                                INSERT INTO artists (artist_id, uri, name, monthly_listeners, image_url, crawled)
                                VALUES (?, ?, ?, ?, ?, ?)
                                ON CONFLICT(artist_id) DO UPDATE SET
                                    name = COALESCE(excluded.name, artists.name),
                                    monthly_listeners = COALESCE(excluded.monthly_listeners, artists.monthly_listeners),
                                    image_url = COALESCE(excluded.image_url, artists.image_url),
                                    crawled = MAX(artists.crawled, excluded.crawled)
                                """,
                                artist_upserts,
                            )

                        if complete_source_ids:
                            cur.executemany(
                                "DELETE FROM edges WHERE source_id = ?",
                                complete_source_ids,
                            )

                        if edge_inserts:
                            cur.executemany(
                                """
                                INSERT OR REPLACE INTO edges (source_id, target_id, rank, weight)
                                VALUES (?, ?, ?, ?)
                                """,
                                edge_inserts,
                            )

                        conn.commit()
                        print(
                            f"Mentve (mélység {depth}): {len(artist_upserts)} előadó, "
                            f"{len(edge_inserts)} él."
                        )

                current_level_uris = next_level_uris

            if enrich_border_nodes:
                cur.execute(
                    "SELECT uri FROM artists WHERE monthly_listeners IS NULL OR image_url IS NULL"
                )
                border_uris = [row[0] for row in cur.fetchall() if row[0]]
                if border_uris:
                    print(f"\n--- Célcsúcsok dúsítása: {len(border_uris)} előadó lekérése ---")
                    for batch_uris in chunked(border_uris, batch_size):
                        tasks = [fetch_listeners_only(spotify, uri, sem) for uri in batch_uris]
                        border_results = await asyncio.gather(*tasks)

                        border_updates: list[tuple[str | None, int | None, str | None, str]] = []
                        for uri, info in border_results:
                            if info:
                                b_name, b_listeners, b_image = info
                                border_updates.append((b_name, b_listeners, b_image, extract_id(uri)))

                        if border_updates:
                            cur.executemany(
                                """
                                UPDATE artists
                                SET name = COALESCE(?, name),
                                    monthly_listeners = COALESCE(?, monthly_listeners),
                                    image_url = COALESCE(?, image_url)
                                WHERE artist_id = ?
                                """,
                                border_updates,
                            )
                            conn.commit()
                            print(f"Célcsúcsok frissítve: {len(border_updates)} előadó.")

        if export_csv:
            node_count, edge_count = export_gephi_csv(db_path=db_name)
            print(f"\nGephi export kész: nodes.csv ({node_count} csúcs), edges.csv ({edge_count} él)")
    finally:
        conn.close()


if __name__ == "__main__":
    asyncio.run(
        crawl_network(
            seed_names=["Krúbi"],
            max_depth=3,
            concurrency=6,
            recrawl=False,
            enrich_border_nodes=True,
            export_csv=True,
        )
    )
