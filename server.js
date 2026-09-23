require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

function logError(label, err) {
  console.error(label, err);
  const line = `[${new Date().toISOString()}] ${label} ${err.stack || err}\n\n`;
  fs.appendFileSync('error-log.txt', line, 'utf8');
}

app.get('/api/data', async (req, res) => {
  try {
    const stateRes = await pool.query('SELECT instructor FROM app_state WHERE id = 1');
    if (stateRes.rows.length === 0) {
      return res.json(null);
    }
    const instructor = stateRes.rows[0].instructor;

    const sectionsRes = await pool.query(
      'SELECT id, title, note FROM sections WHERE state_id = 1 ORDER BY position ASC'
    );

    const sections = [];
    for (const sec of sectionsRes.rows) {
      const rowsRes = await pool.query(
        `SELECT student_name AS name, kid, adult, time_range AS time, class_val AS "classVal",
                location, attendance_date AS date, highlight_color AS "highlightColor"
         FROM attendance_rows WHERE section_id = $1 ORDER BY position ASC`,
        [sec.id]
      );
      const reviewsRes = await pool.query(
        'SELECT student_name AS name, ratings FROM reviews WHERE section_id = $1',
        [sec.id]
      );

      sections.push({
        title: sec.title,
        note: sec.note,
        rows: rowsRes.rows,
        reviews: reviewsRes.rows.map(r => ({ name: r.name, ratings: r.ratings }))
      });
    }

    res.json({ instructor, sections });
  } catch (err) {
    logError('GET /api/data failed:', err);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

app.put('/api/data', async (req, res) => {
  const { instructor, sections } = req.body || {};
  if (!Array.isArray(sections)) {
    return res.status(400).json({ error: 'sections must be an array' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO app_state (id, instructor, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET instructor = $1, updated_at = now()`,
      [instructor || '']
    );

    await client.query('DELETE FROM sections WHERE state_id = 1');

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const secRes = await client.query(
        'INSERT INTO sections (state_id, position, title, note) VALUES (1, $1, $2, $3) RETURNING id',
        [i, sec.title || '', sec.note || '']
      );
      const sectionId = secRes.rows[0].id;

      const rows = Array.isArray(sec.rows) ? sec.rows : [];
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        await client.query(
          `INSERT INTO attendance_rows
           (section_id, position, student_name, kid, adult, time_range, class_val, location, attendance_date, highlight_color)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            sectionId, r,
            row.name || '', row.kid || '', row.adult || '', row.time || '',
            row.classVal || '', row.location || '', row.date || '', row.highlightColor || ''
          ]
        );
      }

      const reviews = Array.isArray(sec.reviews) ? sec.reviews : [];
      for (const rev of reviews) {
        await client.query(
          'INSERT INTO reviews (section_id, student_name, ratings) VALUES ($1,$2,$3)',
          [sectionId, rev.name || '', JSON.stringify(rev.ratings || {})]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('PUT /api/data failed:', err);
    res.status(500).json({ error: 'Failed to save data' });
  } finally {
    client.release();
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Attendance backend running on port ${PORT}`));