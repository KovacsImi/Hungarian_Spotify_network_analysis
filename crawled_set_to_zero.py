import sqlite3

def init_db(db_name="spotify_artist_graph.db"):
    """Létrehozza a helyi SQLite adatbázis tábláit."""
    conn = sqlite3.connect(db_name)
    cur = conn.cursor()
    cur.execute("""
        UPDATE artists SET crawled = 0;
    """)
    conn.commit()
    print("All crawled flag set to 0")



init_db()