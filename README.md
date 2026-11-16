# ChemStep

Frontend PWA + backend Node.js (tanpa dependency). Mendukung **dua peran pengguna — Guru dan Siswa** —
dengan halaman masuk, dashboard, navigasi, dan hak akses yang terpisah (Role-Based Access Control).

## Jalankan
```bash
npm start        # http://localhost:3000
npm test         # tes API (auth, RBAC, progres, tugas, materi) + file statis
```

Saat dijalankan di luar production dan database masih kosong, server membuat akun demo:

| Peran | Username | Kata sandi |
|---|---|---|
| Guru | `guru` | `guru123` |
| Siswa | `siswa` | `siswa123` (sudah tergabung di kelas guru demo) |

### Variabel lingkungan
| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | alamat server |
| `DATA_FILE` | `./data/chemstep-db.json` | file penyimpanan data. Isi `memory` untuk mode in-memory murni |
| `TEACHER_SIGNUP_CODE` | dev: `GURU-CHEMSTEP`; production: acak (dicetak di log) | kode wajib untuk mendaftar sebagai **guru** |
| `SEED_DEMO` | aktif di luar production | `0` = jangan buat akun demo, `1` = paksa buat (juga di production) |
| `COOKIE_SECURE` | otomatis dari HTTPS | `1` = selalu kirim cookie dengan flag `Secure` |

## Alur pengguna
1. **Pilih peran** — halaman awal menampilkan dua pilihan: *Guru* atau *Siswa*.
2. **Masuk / daftar sesuai peran** (`#/masuk/guru`, `#/masuk/siswa`, `#/daftar/...`).
   - Guru mendaftar dengan **kode registrasi guru** (dari admin).
   - Siswa mendaftar dengan **kode kelas** 6 karakter dari gurunya, atau dibuatkan akun oleh guru.
3. **Validasi peran di server** — akun siswa yang mencoba masuk lewat halaman Guru (atau sebaliknya) ditolak
   (`403 ROLE_MISMATCH`), tanpa sesi dibuat. Layar menampilkan tombol untuk pindah ke halaman peran yang benar.
4. **Keluar** — dari menu profil (kanan atas) atau tombol *Keluar* di sidebar, dengan konfirmasi. Setelah keluar,
   pengguna kembali ke halaman pilih peran. Progres siswa disinkronkan dulu sebelum keluar.

## Hak akses
| Fitur | Guru | Siswa |
|---|:-:|:-:|
| Dashboard kelas (statistik, siswa perlu perhatian, langkah tersering keliru) | ✔ | |
| Data siswa: tambah, detail + jawaban langkah, reset sandi, reset progres, hapus, kode kelas | ✔ | |
| Kelola tugas (pilih soal, tenggat, status per siswa) | ✔ | |
| Kelola materi (catatan / tautan per submateri) | ✔ | |
| Bank soal dengan kunci & pembahasan + statistik kelas per soal | ✔ | |
| Laporan Mode Kuis seluruh siswa | ✔ | |
| Beranda, Peta Belajar, Latihan Soal bertahap, Mode Kuis, Progres Saya (fitur lama) | | ✔ |
| Tugas dari guru & Materi dari guru | | ✔ |
| Ubah kata sandi sendiri | ✔ | ✔ |

Pembatasan dilakukan di **dua lapis**: router frontend mengalihkan halaman yang bukan haknya, dan setiap endpoint
API memeriksa peran dari sesi di server (bukan dari data yang dikirim browser).

## API
Semua request yang mengubah data wajib `Content-Type: application/json` (perlindungan CSRF sederhana).
Sesi memakai cookie `HttpOnly; SameSite=Lax` (berlaku 7 hari); kata sandi di-hash dengan scrypt.

| Method | Path | Akses | Fungsi |
|---|---|---|---|
| GET | `/api/health` | publik | health check |
| POST | `/api/auth/login` | publik | `{role, username, password}` |
| POST | `/api/auth/register` | publik | `{role, name, username, password, code}` |
| POST | `/api/auth/logout` | publik | hapus sesi |
| GET | `/api/auth/me` | login | data akun aktif |
| POST | `/api/auth/password` | login | `{oldPassword, newPassword}` |
| GET/PUT/DELETE | `/api/progress` | siswa | progres & draf langkah milik sendiri |
| POST / GET | `/api/quiz-results` | siswa | kirim / lihat hasil kuis sendiri |
| GET | `/api/stats` | login | rata-rata skor kuis semua pengguna (anonim) |
| GET | `/api/assignments`, `/api/materials` | login | guru: miliknya; siswa: dari gurunya |
| POST/PUT/DELETE | `/api/assignments[/:id]`, `/api/materials[/:id]` | guru | kelola tugas & materi |
| GET | `/api/teacher/overview` | guru | ringkasan seluruh siswa + hasil kuis kelas |
| POST | `/api/teacher/class-code` | guru | buat kode kelas baru |
| POST | `/api/teacher/students` | guru | buat akun siswa |
| GET/DELETE | `/api/teacher/students/:id` | guru | detail / hapus siswa (hanya siswa di kelasnya) |
| POST | `/api/teacher/students/:id/password` | guru | reset kata sandi siswa |
| DELETE | `/api/teacher/students/:id/progress` | guru | reset progres siswa |

## Penyimpanan data
- Data (akun, sesi, progres, hasil kuis, tugas, materi) disimpan di memori dan ditulis ke `DATA_FILE`
  (penulisan atomik, ter-debounce) sehingga **tidak hilang saat server restart**.
- Frontend tetap offline-first: progres siswa disimpan juga di localStorage **per akun** dan disinkronkan saat online.
  Progres lama dari versi tanpa akun otomatis dipindahkan ke akun siswa pertama yang masuk di perangkat itu.
- Jalankan **1 instance saja** (data tidak dibagi antar instance).
- Di Docker, data ada di volume `/app/data`. Di Render paket gratis, disk tidak permanen — pasang persistent disk
  dan atur `DATA_FILE` bila data akun harus awet.

## Catatan keamanan
Kunci jawaban soal masih tertanam di frontend (pemeriksaan langkah dilakukan di browser, seperti versi sebelumnya).
Halaman *Bank Soal & Kunci* hanya ditampilkan untuk guru, tetapi siswa yang paham teknis tetap bisa membacanya
dari kode sumber. Untuk ujian sungguhan, pemeriksaan jawaban perlu dipindah ke server.
