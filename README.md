# slack-as-me

CLI tanpa dependency npm untuk menyusun, mengirim, dan menjadwalkan pesan Slack dengan identitas pengirim yang diperiksa. Secara default pengiriman memakai user token milik pemilik akun; mode bot tersedia secara eksplisit. Tool ini berguna ketika akun Slack yang terhubung ke integrasi lain tidak selalu sama dengan akun yang seharusnya mengirim.

`draft` tidak menghubungi Slack. `send` dan `schedule` memeriksa identitas token, tujuan, dan receipt draft sebelum melakukan perubahan di Slack. Tool ini tidak menyediakan pengaturan nama atau avatar pengirim.

## Persyaratan dan instalasi

- Node.js 18 atau lebih baru, dengan `fetch` bawaan.
- macOS untuk menyimpan dan membaca token di Keychain serta menyalin draft dengan `pbcopy`. Draft tetap bisa dibuat di platform lain, tetapi clipboard dan pengiriman berbasis Keychain tidak tersedia.
- Akses ke workspace Slack dan Slack app dengan scope yang sesuai untuk pengiriman. Tidak diperlukan token untuk membuat draft atau menjalankan test.

```bash
git clone git@github.com:amed12/slack-as-me.git
cd slack-as-me
./bin/slack-as-me --help
```

Contoh berikut dijalankan dari direktori repo. Bila ingin memanggil `slack-as-me` dari mana saja, tambahkan direktori `bin` repo ke `PATH` Anda. Tidak ada langkah `npm install`.

Untuk mengaktifkan pengiriman, pemilik akun harus membuat/memasang Slack app dan menyimpan tokennya sendiri. Ikuti [SETUP.md](SETUP.md), lalu jalankan:

```bash
./bin/slack-as-me doctor
./bin/slack-as-me whoami
```

`doctor` memeriksa platform, Keychain, identitas token, scope, dan nilai `--confirm-as` yang tersedia. `whoami` menampilkan identitas secara ringkas. Keduanya membaca Slack tetapi tidak mengirim pesan.

## Alur dasar

1. Simpan isi pesan dalam file, misalnya `pesan.md`, lalu buat draft:

   ```bash
   ./bin/slack-as-me draft --to 'https://workspace.slack.com/archives/C123/p1234567890123456' --file pesan.md
   ```

   Draft menampilkan hasil format Slack, menyimpannya di cache, mencoba menyalin ke clipboard, dan membuat receipt yang berlaku 60 menit. Periksa isi, tujuan, dan pengirim yang akan digunakan. Draft tidak dikirim ke Slack.

2. Setelah isi dan tujuan disetujui, periksa pengiriman tanpa menulis ke Slack. Gunakan user ID yang ditampilkan `doctor` atau `whoami`:

   ```bash
   ./bin/slack-as-me send --to 'https://workspace.slack.com/archives/C123/p1234567890123456' --file pesan.md --confirm-as U123
   ```

3. Setelah ada instruksi eksplisit untuk mengirim, ulangi perintah yang sama dengan `--yes`:

   ```bash
   ./bin/slack-as-me send --to 'https://workspace.slack.com/archives/C123/p1234567890123456' --file pesan.md --confirm-as U123 --yes
   ```

Jika isi, thread, tujuan, lampiran, atau opsi yang memengaruhi isi berubah, buat dan tinjau draft lagi. Receipt hanya membuktikan draft pernah dibuat, **bukan** bukti bahwa seseorang telah menyetujuinya; persetujuan tetap harus diperoleh di luar tool. Receipt juga tidak mengikat identitas pengirim, waktu jadwal, atau `--broadcast`, sehingga periksa semuanya saat dry-run.

## Tujuan dan isi pesan

`--to` menerima link pesan/thread Slack, link channel atau DM, ID channel (`C...`, `G...`, `D...`), atau nama seperti `'#general'`. Link pesan menjadi reply di thread; link reply yang memuat `thread_ts` menggunakan thread induknya. Gunakan `--thread <timestamp>` untuk menentukan thread secara eksplisit, misalnya `1784788621.208259` atau `p1784788621208259`. Nama channel di-resolve saat send/schedule dan membutuhkan scope baca channel; ID atau link lebih langsung.

Isi dapat diberikan melalui `--file pesan.md`, `--text 'Isi pesan'`, atau stdin (`--file -` juga membaca stdin). Secara default Markdown sederhana dinormalisasi ke mrkdwn Slack dan patahan baris manual digabung; code block dipertahankan. Gunakan `--raw` untuk melewati normalisasi, `--no-unwrap` untuk mempertahankan patahan baris, dan `--no-copy` agar draft tidak menyentuh clipboard. Gunakan opsi isi yang sama pada draft dan send.

Pesan dari akun pribadi secara default ditutup dengan `_sent by Claude Code (AI)_`. Teksnya dapat diganti melalui `SLACK_AS_ME_SIGNATURE`; `--no-signature` ditujukan hanya untuk operator manusia yang mengetik pesannya sendiri. Mode bot tidak menambahkan penanda ini. Perubahan penanda mengubah isi dan memerlukan draft ulang.

## Lampiran dan jadwal

Untuk mengirim satu file bersama komentar, sertakan `--attach` pada draft **dan** send:

```bash
./bin/slack-as-me draft --to C123 --file pesan.md --attach laporan.pdf
./bin/slack-as-me send --to C123 --file pesan.md --attach laporan.pdf --confirm-as U123 --yes
```

Token membutuhkan scope `files:write`. Receipt mengikat hash isi lampiran; jika file berubah, draft ulang. Lampiran tidak didukung oleh `schedule`.

Untuk menjadwalkan pesan teks, buat draft seperti biasa, lalu gunakan waktu ISO 8601 di masa depan. Sertakan zona waktu agar jelas:

```bash
./bin/slack-as-me schedule --to C123 --file pesan.md --confirm-as U123 --at '2027-01-15T09:00:00+07:00'
./bin/slack-as-me schedule --to C123 --file pesan.md --confirm-as U123 --at '2027-01-15T09:00:00+07:00' --yes
```

Perintah pertama adalah dry-run; perintah kedua mendaftarkan pesan terjadwal di Slack. `--broadcast` membuat reply thread juga muncul di channel. `--verbose` mencetak panggilan API ke stderr tanpa mencetak isi pesan.

## Mode bot dan beberapa akun

[SETUP.md](SETUP.md#mode-bot---as-bot) menjelaskan pemasangan token bot dan akses channel. Pilih bot secara eksplisit pada draft dan pengiriman:

```bash
./bin/slack-as-me doctor --as-bot nama-bot
./bin/slack-as-me draft --as-bot nama-bot --to C123 --file pesan.md
./bin/slack-as-me send --as-bot nama-bot --to C123 --file pesan.md --confirm-as U123 --yes
```

Pesan tampil sebagai bot dengan label APP. Tanpa `--as-bot`, pengiriman menggunakan user token dan menolak bot token. Untuk akun pribadi, pemilihan account mengikuti `--account`, lalu `SLACK_AS_ME_ACCOUNT`, lalu default di konfigurasi. Gunakan `doctor` untuk melihat nilai `--confirm-as` yang diterima; email mungkin tidak tersedia di workspace tertentu, sehingga user ID adalah pilihan praktis.

## Pengaman dan pemecahan masalah

Sebelum `send` atau `schedule` menulis ke Slack, identitas yang diberikan pada `--confirm-as` harus cocok dengan token, tujuan harus ter-resolve, dan receipt draft harus cocok serta belum lebih dari 60 menit. Tanpa `--yes`, perintah hanya melakukan dry-run setelah pemeriksaan tersebut. Tool menolak field pengubah identitas seperti `username`, `icon_url`, `icon_emoji`, dan `as_user`, serta `blocks` dan `attachments` pada payload pesan.

| Exit | Arti | Langkah berikutnya |
|---|---|---|
| 0 | Berhasil, termasuk dry-run | Periksa output untuk membedakan dry-run dan pengiriman. |
| 1 | Penggunaan/argumen salah | Lihat `--help` dan lengkapi flag. |
| 2 | Input atau target tidak valid | Periksa isi, file, waktu, atau gunakan ID channel yang tepat. |
| 3 | Identitas tidak cocok | Jalankan `doctor`; gunakan identitas token yang memang dimaksud. |
| 4 | Receipt tidak cocok atau kedaluwarsa | Buat dan tinjau draft baru dengan isi, tujuan, thread, dan lampiran yang sama. |
| 5 | Slack API atau jaringan gagal | Periksa error, akses channel, scope, dan koneksi. Bot mungkin perlu diundang ke channel. |
| 6 | Token/account atau scope belum siap | Ikuti [SETUP.md](SETUP.md) dan jalankan `doctor`. |

`--confirm-as` yang hilang menghasilkan exit 1. Nama channel yang tidak ditemukan atau ambigu menghasilkan exit 2. Dry-run tetap menghubungi Slack untuk memeriksa identitas dan, bila perlu, mencari channel; hanya `draft` yang tidak menghubungi Slack.

## Data lokal dan keamanan

| Lokasi | Isi |
|---|---|
| macOS Keychain, service `slack-as-me` | Token user atau bot; jangan bagikan token. |
| `~/.config/slack-as-me/config.json` | Account default, tanpa token. |
| `~/.cache/slack-as-me/drafts/` | Teks draft. |
| `~/.cache/slack-as-me/receipts/` | Metadata receipt, termasuk tujuan dan lokasi draft. |

Draft dapat berisi informasi internal; file draft dan receipt dibuat dengan izin `0600`. Hapus cache tersebut bila tidak lagi diperlukan. Instruksi mencabut akses dan menghapus token ada di [SETUP.md](SETUP.md#mencabut-akses).

## Pengembangan

```bash
node test/run.js
```

Test berjalan tanpa jaringan atau token nyata menggunakan dependency yang disuntik. Kode utama ada di `lib/cli.js`; modul lain menangani Slack API (`slack.js`), Keychain (`keychain.js`), target (`target.js`), receipt (`receipt.js`), format (`mrkdwn.js`), dan konfigurasi (`config.js`). `bin/slack-as-me` adalah entry point, sedangkan `manifest.yaml` berisi scope user untuk Slack app.
