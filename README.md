# ChemStep

Platform belajar stoikiometri bertahap (60 soal, 12 submateri). Frontend statis + backend Express **in-memory** (tanpa database), siap deploy di Vercel.

## Struktur

```
├── api/index.js       # entry serverless Vercel (re-export app Express)
├── dev-server.js      # server lokal (static + API)
├── lib/
│   ├── app.js         # Express app: semua route /api/*
│   ├── store.js       # penyimpanan progres in-memory
│   └── answer.js      # logika pencocokan jawaban
├── data/              # topics.js & questions.js (bank soal)
├── public/index.html  # frontend (di-serve sebagai static oleh Vercel)
├── test/api.test.js
└── vercel.json        # rewrite /api/* -> function
```

## Jalankan lokal

```bash
npm install
npm run dev      # http://localhost:3000
npm test
```

## Deploy ke Vercel

**Via dashboard (paling mudah)**
1. Push folder ini ke GitHub.
2. Di vercel.com → **Add New → Project** → import repo.
3. Framework Preset: **Other** (`vercel.json` sudah mengatur output ke `public/`, tidak perlu build). Klik **Deploy**.

**Via CLI**
```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

Tidak ada environment variable wajib. `CORS_ORIGIN` (lihat `.env.example`) hanya perlu jika frontend di-host di domain lain.

## API

Semua response JSON. Endpoint progres membutuhkan header `X-Client-Id` (8–64 karakter: huruf/angka/`_`/`-`). Frontend membuat ID acak otomatis dan menyimpannya di `localStorage`.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/health` | Cek status |
| GET | `/api/topics` | 12 submateri + jumlah soal |
| GET | `/api/questions?topic=0-11&level=Basic&q=kata` | Daftar soal (semua filter opsional). Kunci jawaban **tidak** disertakan |
| GET | `/api/questions/:id` | Detail satu soal (id 1–60) |
| POST | `/api/questions/:id/check` | Body `{"answer":"110 gram"}` → `{"correct":true,"saved":true}`. Jika benar dan ada `X-Client-Id`, progres tersimpan |
| GET | `/api/progress` | Progres klien: `learned`, `done`, `total`, `percent`, ringkasan per submateri |
| PUT | `/api/progress` | Body `{"learned":[1,2,3]}` → gabungkan id soal ke progres (dipakai frontend untuk sinkron ulang) |
| DELETE | `/api/progress` | Reset progres klien |

Contoh:
```bash
curl -X POST https://<app>.vercel.app/api/questions/1/check \
  -H "Content-Type: application/json" -H "X-Client-Id: demo-client-001" \
  -d '{"answer":"110 gram"}'
```

## Penting: batasan in-memory di Vercel

Vercel menjalankan backend sebagai *serverless function*. Data in-memory hanya hidup selama instance function itu "hangat":

- hilang saat **cold start** atau **redeploy**,
- **tidak dibagi** antar-instance (request berbeda bisa mendarat di instance berbeda).

Untuk mengurangi dampaknya, frontend tetap menyimpan salinan progres di `localStorage` dan mengirimnya lewat `PUT /api/progress` setiap halaman dibuka, sehingga progres pengguna tidak hilang. Jika nanti butuh data yang benar-benar persisten/lintas perangkat, cukup ganti isi `lib/store.js` dengan Vercel KV / Upstash Redis / Postgres. Route di `lib/app.js` tidak perlu diubah.

## Catatan

- Store dibatasi 5.000 klien (yang paling lama tidak aktif dibuang) agar memori tidak membengkak.
- Body JSON dibatasi 10 KB; panjang jawaban maksimal 200 karakter.
- Bank soal ada di `data/questions.js`; jumlah soal per submateri diasumsikan 5 (id → submateri = `floor((id-1)/5)`).

## Troubleshooting

- **`Cannot GET /` di halaman utama**: Vercel mengira project ini aplikasi Express karena ada `app.js`/`server.js` di root. Pastikan file Express ada di `lib/app.js` dan `vercel.json` berisi `"framework": null` + `"outputDirectory": "public"`. Di dashboard Vercel, cek **Settings → Build & Development → Framework Preset = Other**, lalu redeploy.
