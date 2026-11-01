# SETUP -- dijalankan oleh PEMILIK AKUN SLACK sendiri

Mode `draft` jalan tanpa setup apa pun. Dokumen ini hanya untuk mengaktifkan
mode `send`/`schedule`.

> **Langkah 3 dan 4 harus dilakukan oleh pemilik akun Slack itu sendiri.**
> Token `xoxp-` adalah kredensial pribadi yang bisa menulis atas namanya di
> seluruh workspace. Orang lain tidak boleh mengambil atau menempelkannya --
> termasuk operator sesi Claude Code yang login dengan email berbeda.

## 1. Buat Slack app

1. Buka <https://api.slack.com/apps> -> **Create New App** -> **From scratch**.
2. Nama bebas (mis. `slack-as-me CLI`), pilih workspace Slack Anda.

## 2. Minta User Token Scopes

Di halaman **OAuth & Permissions**, gulir ke *Scopes*. Isi bagian
**User Token Scopes** -- bukan *Bot Token Scopes*:

| Scope | Untuk apa |
|---|---|
| `chat:write` | mengirim pesan sebagai Anda |
| `channels:read` | resolve `#nama-channel` publik ke channel ID |
| `groups:read` | resolve channel privat yang Anda ikuti |
| `users:read` | menampilkan nama Anda di output `whoami` |
| `users:read.email` | mencocokkan `--confirm-as <email>` **kalau** workspace mengizinkan; di Qiscus Tech tidak, jadi pakai user ID |
| `files:write` | lampiran lewat `--attach` (opsional; tanpa scope ini hanya `--attach` yang ditolak, exit 6) |

Untuk pengiriman sebagai user, gunakan User Token Scopes dan token `xoxp-`.
Token bot `xoxb-` dipakai hanya dalam mode bot eksplisit di bawah.

### Menambah `files:write` ke app yang sudah terpasang

Tambahkan `files:write` di **User Token Scopes**, lalu **Reinstall to Workspace**
(token lama tidak ikut mendapat scope baru). Jalankan `slack-as-me login` lagi
dengan User OAuth Token yang baru, lalu `slack-as-me doctor`: baris
`scope files:write` harus `ada`.

## 3. Install ke workspace

**Install to Workspace** -> *Allow*. Salin **User OAuth Token** (`xoxp-...`).

Workspace Qiscus mungkin mensyaratkan **approval admin** untuk install app baru.
Kalau tombolnya berubah jadi *Request to Install*, itu bukan kegagalan skrip --
tunggu admin menyetujui.

## 4. Simpan token di mesin ini

```bash
cd /path/ke/slack-as-me
./bin/slack-as-me login --account <email-slack-anda>
```

Token diminta lewat prompt dan **tidak tampil di layar**; ia masuk ke macOS
Keychain (service `slack-as-me`), bukan ke file mana pun. Skrip langsung
menjalankan `auth.test` dan mencetak identitas yang terdeteksi -- periksa bahwa
itu benar Anda sebelum melanjutkan.

Kalau token ditolak Slack, tidak ada yang disimpan.

## 5. Konfirmasi

```bash
./bin/slack-as-me doctor
```

Read-only dan memeriksa semuanya sekaligus: platform, Keychain, identitas token,
scope yang melekat, dan nilai `--confirm-as` yang sah. Semua baris harus `OK`.

`./bin/slack-as-me whoami` memberi versi ringkasnya.

## 6. Uji kirim pertama ke DM sendiri, bukan channel tim

Jangan uji langsung ke thread kerja. Ambil channel ID DM Anda sendiri di Slack
(buka DM dengan diri sendiri -> *Copy link* -> bagian `D...`), lalu:

```bash
./bin/slack-as-me draft --to D0XXXXXXX --text "tes slack-as-me"
./bin/slack-as-me send  --to D0XXXXXXX --text "tes slack-as-me" \
    --confirm-as <user-id-dari-whoami> --yes
```

Periksa di Slack: pesan tampil sebagai Anda, **tanpa** label `APP` atau `BOT`.

## Mencabut akses

Hapus app di <https://api.slack.com/apps> (*Basic Information* -> *Delete App*),
lalu buang tokennya dari mesin ini:

```bash
security delete-generic-password -s slack-as-me -a <email-slack-anda>
```

## Catatan: `--confirm-as` pakai user ID, bukan email

Di sebagian workspace (termasuk Qiscus Tech) `users.info` menolak dengan
`user_not_found` walau scope `users:read` dan `users:read.email` sudah diberikan,
sehingga email tidak bisa diambil. `whoami` akan menampilkan handle + user ID saja.

Pakai **user ID** yang dicetak `whoami` untuk `--confirm-as` (mis. `U01DGERLBQU`).
Handle (`fathullah`) juga cocok. Ini justru pengikat yang lebih kuat daripada email:
user ID tidak berubah kalau email atau nama tampilan diganti.

## Mode bot (`--as-bot`)

Ditambahkan 2026-10-26 atas permintaan operator, disetujui TL: pesan agen boleh
tampil sebagai **bot milik operator** (mis. `buz`), bukan sebagai akun pribadi.
Pesan tampil dengan nama bot dan label `APP`. Penanda `_sent by Claude Code (AI)_`
**tidak** ditempel lewat bot (label APP sudah menandai pesan bukan ketikan manusia;
keputusan TL via operator, 2026-10-26). `draft` juga harus memakai `--as-bot <nama>`
supaya receipt cocok. Nama/avatar tetap tidak bisa diatur (allowlist `lib/slack.js`).

1. Di app Slack milik bot, *OAuth & Permissions* -> **Bot Token Scopes**: `chat:write`.
   Install/reinstall, salin **Bot User OAuth Token** (`xoxb-...`).
2. Pemilik bot menyimpan token sendiri (tidak tampil, tidak masuk history):

   ```bash
   ./bin/slack-as-me login --bot buz
   ```

   Token disimpan di Keychain service `slack-as-me`, account `bot:buz`. Tidak
   mengubah pengirim default; tanpa `--as-bot`, `send` tetap memakai user token.
3. Undang bot ke channel tujuan: `/invite @buz`. Tanpa ini Slack menjawab
   `not_in_channel` (exit 5, pesan error menyebut perintah undangnya).
4. Periksa: `./bin/slack-as-me doctor --as-bot buz` lalu kirim:

   ```bash
   ./bin/slack-as-me draft --as-bot buz --to <link> --file <draft>
   ./bin/slack-as-me send  --as-bot buz --to <link> --file <draft> \
       --confirm-as <user-id-bot-dari-doctor> --yes
   ```

`--confirm-as` untuk bot menerima user ID bot (`U...`), handle, atau `bot_id`
(`B...`). Receipt draft, `--yes`, dan resolve channel berlaku sama. Kirim ke
`#nama` butuh scope `channels:read`/`groups:read` di bot; pakai link atau
channel ID kalau scope itu tidak ada.

Cabut: `security delete-generic-password -s slack-as-me -a bot:buz`.
