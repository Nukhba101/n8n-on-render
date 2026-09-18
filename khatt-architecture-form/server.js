const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 10000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });
const EXPORT_TOKEN = process.env.EXPORT_TOKEN || '';

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizePhone(v='') { return String(v).replace(/\D/g, ''); }
function csvEscape(v='') {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS architecture_registrations (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      name TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      whatsapp_norm TEXT NOT NULL UNIQUE,
      university TEXT NOT NULL,
      major TEXT NOT NULL,
      study_year TEXT NOT NULL,
      level TEXT NOT NULL,
      challenge TEXT NOT NULL,
      interest TEXT NOT NULL,
      question TEXT,
      availability TEXT,
      status TEXT NOT NULL DEFAULT 'جديد',
      notes TEXT DEFAULT ''
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS architecture_form_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

app.get('/healthz', async (req,res) => {
  try { await pool.query('SELECT 1'); res.json({ok:true}); }
  catch(e){ res.status(500).json({ok:false}); }
});

app.post('/api/register', async (req,res) => {
  try {
    const d = req.body || {};
    const required = ['name','whatsapp','university','major','year','level','challenge','interest'];
    for (const k of required) if (!String(d[k] || '').trim()) return res.status(400).json({ok:false,message:'الحقول المطلوبة غير مكتملة.'});
    const phoneNorm = normalizePhone(d.whatsapp);
    if (phoneNorm.length < 8) return res.status(400).json({ok:false,message:'رقم واتساب غير صالح.'});
    const q = `INSERT INTO architecture_registrations
      (name,whatsapp,whatsapp_norm,university,major,study_year,level,challenge,interest,question,availability)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id, created_at`;
    const vals = [d.name.trim(), d.whatsapp.trim(), phoneNorm, d.university.trim(), d.major.trim(), d.year.trim(), d.level.trim(), d.challenge.trim(), d.interest.trim(), String(d.question||'').trim(), String(d.availability||'').trim()];
    const r = await pool.query(q, vals);
    res.json({ok:true,id:r.rows[0].id});
  } catch(e) {
    if (e && e.code === '23505') return res.status(409).json({ok:false,message:'يوجد تسجيل سابق بهذا الرقم.'});
    console.error(e); res.status(500).json({ok:false,message:'تعذر حفظ التسجيل الآن.'});
  }
});

// One-time token claim used only to connect the private Google Sheet import.
app.get('/setup-export-token', async (req,res) => {
  try {
    if (!EXPORT_TOKEN) return res.status(500).json({ok:false});
    const claimed = await pool.query("SELECT value FROM architecture_form_meta WHERE key='export_token_claimed'");
    if (claimed.rows[0]?.value === 'yes') return res.status(410).json({ok:false,message:'claimed'});
    await pool.query("INSERT INTO architecture_form_meta(key,value) VALUES('export_token_claimed','yes') ON CONFLICT(key) DO UPDATE SET value='yes'");
    res.json({ok:true,token:EXPORT_TOKEN});
  } catch(e) { res.status(500).json({ok:false}); }
});

app.get('/export.csv', async (req,res) => {
  if (!EXPORT_TOKEN || req.query.token !== EXPORT_TOKEN) return res.status(403).send('forbidden');
  const r = await pool.query(`SELECT created_at,name,whatsapp,university,major,study_year,level,challenge,interest,question,availability,status,notes FROM architecture_registrations ORDER BY created_at ASC`);
  const headers = ['وقت التسجيل','الاسم الكامل','رقم واتساب','الجامعة','التخصص','السنة الدراسية','المستوى الحالي','أكبر تحدٍ','المحور الأكثر اهتمامًا','سؤال للمختص','الأوقات المناسبة','حالة التسجيل','ملاحظات الفريق'];
  const rows = [headers, ...r.rows.map(x => [x.created_at.toISOString(),x.name,x.whatsapp,x.university,x.major,x.study_year,x.level,x.challenge,x.interest,x.question||'',x.availability||'',x.status,x.notes||''])];
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.send('\uFEFF' + csv);
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

init().then(() => app.listen(port, () => console.log(`KHATT form listening on ${port}`))).catch(err => { console.error(err); process.exit(1); });
