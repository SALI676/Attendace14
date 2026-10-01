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
    const stateRes = await pool.query('SELECT instructor, receipt FROM app_state WHERE id = 1');
    if (stateRes.rows.length === 0) {
      return res.json(null);
    }
    const instructor = stateRes.rows[0].instructor;
    const receipt = stateRes.rows[0].receipt || undefined; // receipt + certificate JSON

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

    res.json({ instructor, sections, receipt });
  } catch (err) {
    logError('GET /api/data failed:', err);
    res.status(500).json({ error: 'Failed to load data' });
  }
});

app.put('/api/data', async (req, res) => {
  const { instructor, sections, receipt } = req.body || {};
  if (!Array.isArray(sections)) {
    return res.status(400).json({ error: 'sections must be an array' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO app_state (id, instructor, receipt, updated_at) VALUES (1, $1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE
         SET instructor = $1,
             receipt = COALESCE($2::jsonb, app_state.receipt),
             updated_at = now()`,
      [instructor || '', receipt ? JSON.stringify(receipt) : null]
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

// ---------- Receipts: uses 3 tables (customer_information, program_details, price_list) ----------
// Create the tables first by running schema.sql in PostgreSQL.
const str = v => (v === undefined || v === null ? '' : String(v));

// Save (or update) one student's receipt across the 3 tables
app.put('/api/receipts', async (req, res) => {
  const { customer, program, prices } = req.body || {};
  if (!customer || !str(customer.studentName).trim()) {
    return res.status(400).json({ error: 'customer.studentName is required' });
  }
  const p = program || {};
  const priceRows = Array.isArray(prices) ? prices : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cust = await client.query(
      `INSERT INTO customer_information (student_name, mobile_telegram, receipt_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (student_name) DO UPDATE
         SET mobile_telegram = EXCLUDED.mobile_telegram,
             receipt_date = EXCLUDED.receipt_date,
             updated_at = now()
       RETURNING id`,
      [str(customer.studentName).trim(), str(customer.mobile), str(customer.receiptDate)]
    );
    const customerId = cust.rows[0].id;

    await client.query(
      `INSERT INTO program_details (customer_id, program_name, location, student_type, sessions, start_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (customer_id) DO UPDATE
         SET program_name = EXCLUDED.program_name, location = EXCLUDED.location,
             student_type = EXCLUDED.student_type, sessions = EXCLUDED.sessions,
             start_date = EXCLUDED.start_date, updated_at = now()`,
      [customerId, str(p.program), str(p.location), str(p.studentType), str(p.sessions), str(p.startDate)]
    );

    await client.query('DELETE FROM price_list WHERE customer_id = $1', [customerId]);
    for (let i = 0; i < priceRows.length; i++) {
      const r = priceRows[i] || {};
      await client.query(
        `INSERT INTO price_list (customer_id, position, item_no, description, original_price, unit_price, total_price, remark)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [customerId, i, str(r.no), str(r.description), str(r.originalPrice),
         str(r.unitPrice), str(r.totalPrice), str(r.remark)]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, customerId });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('PUT /api/receipts failed:', err);
    res.status(500).json({ error: 'Failed to save receipt' });
  } finally {
    client.release();
  }
});

// Load the most recently saved receipt (fills the receipt page when it opens)
app.get('/api/receipts/latest', async (req, res) => {
  try {
    const cust = await pool.query(
      `SELECT id, student_name, mobile_telegram, receipt_date
       FROM customer_information ORDER BY updated_at DESC LIMIT 1`
    );
    if (cust.rows.length === 0) return res.json(null);
    const c = cust.rows[0];

    const prog = await pool.query(
      `SELECT program_name, location, student_type, sessions, start_date
       FROM program_details WHERE customer_id = $1`, [c.id]
    );
    const price = await pool.query(
      `SELECT item_no AS no, description, original_price AS "originalPrice",
              unit_price AS "unitPrice", total_price AS "totalPrice", remark
       FROM price_list WHERE customer_id = $1 ORDER BY position ASC`, [c.id]
    );
    const p = prog.rows[0] || {};

    res.json({
      customer: { studentName: c.student_name, mobile: c.mobile_telegram, receiptDate: c.receipt_date },
      program: {
        program: p.program_name || '', location: p.location || '', studentType: p.student_type || '',
        sessions: p.sessions || '', startDate: p.start_date || ''
      },
      prices: price.rows
    });
  } catch (err) {
    logError('GET /api/receipts/latest failed:', err);
    res.status(500).json({ error: 'Failed to load receipt' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Attendance backend running on port ${PORT}`));
