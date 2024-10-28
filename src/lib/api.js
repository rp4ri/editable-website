import slugify from 'slugify';
import { SHORTCUTS } from './constants';
import { createClient } from '@libsql/client';
import { nanoid } from '$lib/util';
import { DB_PATH, ADMIN_PASSWORD } from '$env/static/private';
import { Blob } from 'node:buffer';

const db = createClient({
  url: DB_PATH,
  authToken: ADMIN_PASSWORD
});

/**
 * Creates a new article
 */
export async function createArticle(title, content, teaser, currentUser) {
  if (!currentUser) throw new Error('Not authorized');

  let slug = slugify(title, { lower: true, strict: true });

  // Check if slug is already used
  const articleExists = await db.execute('SELECT * FROM articles WHERE slug = ?', [slug]);
  if (articleExists.rows.length > 0) {
    slug = slug + '-' + nanoid();
  }

  await db.execute(
    `INSERT INTO articles (slug, title, content, teaser, published_at) VALUES (?, ?, ?, ?, DATETIME('now'))`,
    [slug, title, content, teaser]
  );

  const newArticle = await db.execute("SELECT slug, created_at FROM articles WHERE slug = ?", [slug]);
  return newArticle.rows[0];
}

/**
 * Updates an article
 */
export async function updateArticle(slug, title, content, teaser, currentUser) {
  if (!currentUser) throw new Error('Not authorized');

  await db.execute(
    `UPDATE articles SET title = ?, content = ?, teaser = ?, updated_at = datetime('now') WHERE slug = ?`,
    [title, content, teaser, slug]
  );

  const updatedArticle = await db.execute("SELECT slug, updated_at FROM articles WHERE slug = ?", [slug]);
  return updatedArticle.rows[0];
}

/**
 * Authentication
 */
export async function authenticate(password, sessionTimeout) {
  const expires = __getDateTimeMinutesAfter(sessionTimeout);
  if (password === ADMIN_PASSWORD) {
    const sessionId = nanoid();

    await db.execute('DELETE FROM sessions WHERE expires < ?', [new Date().toISOString()]);

    await db.execute(
      'INSERT INTO sessions (session_id, expires) VALUES (?, ?)',
      [sessionId, expires]
    );

    return { sessionId };
  } else {
    throw 'Authentication failed.';
  }
}

/**
 * Destroy session
 */
export async function destroySession(sessionId) {
  await db.execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
  return true;
}

/**
 * Get all articles
 */
export async function getArticles(currentUser) {
  let query;
  if (currentUser) {
    query = 'SELECT *, COALESCE(published_at, updated_at, created_at) AS modified_at FROM articles ORDER BY modified_at DESC';
  } else {
    query = 'SELECT * FROM articles WHERE published_at IS NOT NULL ORDER BY published_at DESC';
  }

  const articles = await db.execute(query);
  return articles.rows;
}

/**
 * Get the next article by slug
 */
export async function getNextArticle(slug) {
  const query = `
    WITH previous_published AS (
      SELECT title, teaser, slug, published_at
      FROM articles
      WHERE published_at < (SELECT published_at FROM articles WHERE slug = ?)
      ORDER BY published_at DESC
      LIMIT 1
    ),
    latest_article AS (
      SELECT title, teaser, slug, published_at
      FROM articles
      WHERE slug <> ?
      ORDER BY published_at DESC
      LIMIT 1
    )
    SELECT title, teaser, slug, published_at
    FROM (
      SELECT * FROM previous_published
      UNION
      SELECT * FROM latest_article
    )
    ORDER BY published_at ASC
    LIMIT 1;
  `;

  const result = await db.execute(query, [slug, slug]);
  return result.rows[0];
}

/**
 * Search articles
 */
export async function search(q, currentUser) {
  let query;
  if (currentUser) {
    query = `SELECT title AS name, '/blog/' || slug AS url, COALESCE(published_at, updated_at, created_at) AS modified_at
      FROM articles
      WHERE title LIKE ? COLLATE NOCASE ORDER BY modified_at DESC`;
  } else {
    query = `SELECT title AS name, '/blog/' || slug AS url, COALESCE(published_at, updated_at, created_at) AS modified_at
      FROM articles
      WHERE title LIKE ? COLLATE NOCASE AND published_at IS NOT NULL ORDER BY modified_at DESC`;
  }

  const results = await db.execute(query, [`%${q}%`]);
  const rows = results.rows;

  SHORTCUTS.forEach(shortcut => {
    if (shortcut.name.toLowerCase().includes(q.toLowerCase())) {
      rows.push(shortcut);
    }
  });

  return rows;
}

/**
 * Get article by slug
 */
export async function getArticleBySlug(slug) {
  const result = await db.execute("SELECT * FROM articles WHERE slug = ?", [slug]);
  return result.rows[0];
}

/**
 * Delete article
 */
export async function deleteArticle(slug, currentUser) {
  if (!currentUser) throw new Error('Not authorized');

  const result = await db.execute("DELETE FROM articles WHERE slug = ?", [slug]);
  return result.affectedRows > 0;
}

/**
 * Get current user by session
 */
export async function getCurrentUser(session_id) {
  const result = await db.execute(
    'SELECT session_id, expires FROM sessions WHERE session_id = ? AND expires > ?',
    [session_id, new Date().toISOString()]
  );

  return result.rows.length ? { name: 'Admin' } : null;
}

/**
 * Create or update page
 */
export async function createOrUpdatePage(page_id, page, currentUser) {
  if (!currentUser) throw new Error('Not authorized');
  const pageExists = await db.execute('SELECT page_id FROM pages WHERE page_id = ?', [page_id]);
  
  if (pageExists.rows.length) {
    return (await db.execute(
      'UPDATE pages SET data = ?, updated_at = ? WHERE page_id = ? RETURNING page_id',
      [JSON.stringify(page), new Date().toISOString(), page_id]
    )).rows[0];
  } else {
    return (await db.execute(
      'INSERT INTO pages (page_id, data, updated_at) VALUES (?, ?, ?) RETURNING page_id',
      [page_id, JSON.stringify(page), new Date().toISOString()]
    )).rows[0];
  }
}

/**
 * Get page by ID
 */
export async function getPage(page_id) {
  const page = await db.execute('SELECT data FROM pages WHERE page_id = ?', [page_id]);
  return page.rows[0] ? JSON.parse(page.rows[0].data) : null;
}

/**
 * Create or update counter
 */
export async function createOrUpdateCounter(counter_id) {
  const counterExists = await db.execute('SELECT counter_id FROM counters WHERE counter_id = ?', [counter_id]);
  
  if (counterExists.rows.length) {
    return (await db.execute(
      'UPDATE counters SET count = count + 1 WHERE counter_id = ? RETURNING count',
      [counter_id]
    )).rows[0];
  } else {
    return (await db.execute(
      'INSERT INTO counters (counter_id, count) VALUES (?, 1) RETURNING count',
      [counter_id]
    )).rows[0];
  }
}

/**
 * Store an asset
 */
export async function storeAsset(asset_id, file) {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const sql = `
    INSERT INTO assets (asset_id, mime_type, updated_at, size, data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (asset_id) DO UPDATE SET
      mime_type = excluded.mime_type,
      updated_at = excluded.updated_at,
      size = excluded.size,
      data = excluded.data
    WHERE asset_id = excluded.asset_id
  `;
  await db.execute(sql, [asset_id, file.type, new Date().toISOString(), file.size, buffer]);
}

/**
 * Get asset by ID
 */
export async function getAsset(asset_id) {
  const result = await db.execute(`
    SELECT asset_id, mime_type, updated_at, size, data
    FROM assets
    WHERE asset_id = ?
  `, [asset_id]);

  const row = result.rows[0];
  return {
    filename: row.asset_id.split('/').slice(-1),
    mimeType: row.mime_type,
    lastModified: row.updated_at,
    size: row.size,
    data: new Blob([row.data], { type: row.mime_type })
  };
}

/**
 * Helpers
 */
function __getDateTimeMinutesAfter(minutes) {
  return new Date(Date.now() + minutes * 60000).toISOString();
}
