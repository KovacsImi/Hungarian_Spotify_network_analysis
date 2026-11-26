import argparse
import csv
import sqlite3
from pathlib import Path


def export_gephi_csv(
    db_path: str | Path = "spotify_artist_graph.db",
    nodes_path: str | Path = "nodes.csv",
    edges_path: str | Path = "edges.csv",
    *,
    only_crawled: bool = False,
    fill_missing_listeners: int | None = None,
    with_bom: bool = False,
) -> tuple[int, int]:
    """Exportáljuk az SQLite adatbázisból a Gephi-hez szükséges nodes.csv és edges.csv fájlokat.

    Args:
        db_path: A forrás SQLite adatbázis útvonala.
        nodes_path: A kimeneti csúcslista CSV útvonala.
        edges_path: A kimeneti éllista CSV útvonala.
        only_crawled: Ha True, csak a teljesen bejárt (crawled = 1) előadókat és a köztük lévő éleket exportálja.
        fill_missing_listeners: Ha meg van adva (pl. 0), a NULL havi hallgatószámot erre cseréli;
            None esetén üres cella marad (a Gephi így hiányzó/null értékként kezeli).
        with_bom: Ha True, UTF-8 BOM-mal ment (Excelhez); alapértelmezettként False (Gephi szabvány UTF-8).

    Returns:
        (exportált_csúcsok_száma, exportált_élek_száma)
    """
    encoding = "utf-8-sig" if with_bom else "utf-8"
    conn = sqlite3.connect(str(db_path))

    try:
        cur = conn.cursor()
        cols = {row[1] for row in cur.execute("PRAGMA table_info(artists)").fetchall()}
        has_image = "image_url" in cols
        image_select = "image_url" if has_image else "NULL AS image_url"

        if only_crawled:
            cur.execute(
                f"""
                SELECT artist_id, name, monthly_listeners, crawled, uri, {image_select}
                FROM artists
                WHERE crawled = 1
                ORDER BY monthly_listeners DESC NULLS LAST, name ASC
                """
            )
        else:
            cur.execute(
                f"""
                SELECT artist_id, name, monthly_listeners, crawled, uri, {image_select}
                FROM artists
                ORDER BY crawled DESC, monthly_listeners DESC NULLS LAST, name ASC
                """
            )

        nodes = cur.fetchall()
        node_count = len(nodes)

        with open(nodes_path, "w", newline="", encoding=encoding) as f:
            writer = csv.writer(f)
            writer.writerow(["Id", "Label", "monthly_listeners", "crawled", "uri", "image"])
            for artist_id, name, listeners, crawled, uri, image_url in nodes:
                label = name if name else artist_id
                listeners_val = (
                    listeners
                    if listeners is not None
                    else ("" if fill_missing_listeners is None else fill_missing_listeners)
                )
                writer.writerow([artist_id, label, listeners_val, crawled, uri, image_url or ""])

        if only_crawled:
            cur.execute(
                """
                SELECT e.source_id, e.target_id, e.weight, e.rank
                FROM edges e
                JOIN artists s ON e.source_id = s.artist_id AND s.crawled = 1
                JOIN artists t ON e.target_id = t.artist_id AND t.crawled = 1
                ORDER BY e.source_id, e.rank
                """
            )
        else:
            cur.execute(
                """
                SELECT e.source_id, e.target_id, e.weight, e.rank
                FROM edges e
                JOIN artists s ON e.source_id = s.artist_id
                JOIN artists t ON e.target_id = t.artist_id
                ORDER BY e.source_id, e.rank
                """
            )

        edges = cur.fetchall()
        edge_count = len(edges)

        with open(edges_path, "w", newline="", encoding=encoding) as f:
            writer = csv.writer(f)
            writer.writerow(["Source", "Target", "Type", "Weight", "Rank"])
            for src, tgt, weight, rank in edges:
                writer.writerow([src, tgt, "Directed", weight, rank])

        return node_count, edge_count
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Spotify előadói gráf exportálása Gephi CSV formátumba.")
    parser.add_argument("--db", default="spotify_artist_graph.db", help="Bemeneti SQLite adatbázis")
    parser.add_argument("--nodes", default="nodes.csv", help="Kimeneti nodes CSV fájl")
    parser.add_argument("--edges", default="edges.csv", help="Kimeneti edges CSV fájl")
    parser.add_argument(
        "--only-crawled",
        action="store_true",
        help="Csak a crawled=1 előadók és a köztük lévő élek exportálása",
    )
    parser.add_argument(
        "--fill-missing",
        type=int,
        default=None,
        help="Hiányzó (NULL) hallgatószám helyettesítése számmal (pl. 0)",
    )
    parser.add_argument(
        "--bom",
        action="store_true",
        help="UTF-8 BOM írása (Excel kompatibilitáshoz; Gephihez alapból nem ajánlott)",
    )
    args = parser.parse_args()

    node_count, edge_count = export_gephi_csv(
        db_path=args.db,
        nodes_path=args.nodes,
        edges_path=args.edges,
        only_crawled=args.only_crawled,
        fill_missing_listeners=args.fill_missing,
        with_bom=args.bom,
    )
    print(f"Gephi export kész: {args.nodes} ({node_count} csúcs), {args.edges} ({edge_count} él)")


if __name__ == "__main__":
    main()
