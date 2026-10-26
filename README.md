# slack-as-me

Menyusun dan mengirim pesan Slack dengan **identitas yang pasti**.

## Masalah yang diselesaikan

MCP `claude_ai_Slack` bisa tersambung ke akun Slack yang berbeda-beda per
sesi/device. Kalau pesan dikirim lewat MCP, penulis pesan di Slack adalah
"siapa pun yang kebetulan tersambung". Ini sudah pernah kejadian: pesan masuk
ke channel tim atas nama akun yang salah dan tidak bisa ditarik, karena MCP
Slack tidak punya tool delete/edit.

`slack-as-me` mengirim memakai **user token milik pemilik akun sendiri** dari
macOS Keychain, jadi authorship-nya sah dan tidak bergantung akun MCP mana yang
sedang aktif.

## Yang sengaja TIDAK ada

Tool ini **tidak bisa** mengatur nama atau avatar pengirim. `lib/slack.js`
memakai allowlist field; `username`, `icon_url`, `icon_emoji`, `as_user`,
`blocks`, dan `attachments` ditolak dengan error, bukan diabaikan diam-diam.

Membuat pesan tampil sebagai orang lain padahal bukan dia yang menulis adalah
pemalsuan authorship -- pembaca thread tidak punya cara membedakannya. Jadi
kemampuan itu tidak disediakan, bukan cuma tidak dipakai.

## Mode bot

`--as-bot <nama>` (sejak 2026-10-26) mengirim lewat bot milik operator, mis. `buz`:
pesan tampil sebagai bot itu (label `APP`), tanpa penanda AI (label APP sudah
menandainya; `draft` juga pakai `--as-bot`), dan keempat pengaman tetap berlaku. Harus diminta per perintah; tanpa flag itu `send` tetap memakai user token
dan menolak bot token. Setup di `SETUP.md` bagian "Mode bot".

## Periksa dulu kalau ragu

```bash
slack-as-me doctor
```

Read-only, tidak mengirim apa pun. Mencetak platform, isi Keychain, identitas
token, scope yang benar-benar melekat, dan **daftar nilai `--confirm-as` yang
sah**. Kalau sebuah nilai `--confirm-as` ditolak, jawabannya ada di sini -- jangan
menebak-nebak dan jangan mencoba parameter berulang ke jalur kirim.

## Dua mode

```bash
# default: tidak menyentuh Slack sama sekali
slack-as-me draft --to <link|channelId|#nama> --file pesan.md

# hanya setelah user bilang "kirim"
slack-as-me send  --to <...> --file pesan.md --confirm-as <user-id> --yes
```

`draft` menormalkan teks ke mrkdwn Slack (`**tebal**` -> `*tebal*`, patahan baris
manual digabung supaya tidak berantakan di mobile, isi code block dibiarkan),
menaruhnya di clipboard, dan mencatat *receipt*.

## Empat pengaman di jalur kirim

Semuanya harus lolos; gagal salah satu = tidak ada apa pun yang masuk Slack.

| # | Pengaman | Gagal -> exit |
|---|---|---|
| 1 | `--confirm-as` wajib dan dicocokkan ke `auth.test` live (user ID, handle, atau email) | `3` |
| 2 | Receipt dari mode `draft` untuk body+thread yang **persis sama**, maks 60 menit | `4` |
| 3 | `--yes` wajib; tanpa itu hanya dry-run | `0` (tidak kirim) |
| 4 | Channel harus resolve ke satu channel ID (`#nama` ambigu ditolak) | `2` |

Pengaman 2 yang paling penting dalam praktik: ia membuat aturan "tampilkan draft
dulu, kirim hanya kalau disuruh eksplisit" di `~/.claude/CLAUDE.md` jadi
pemeriksaan mesin, bukan sesuatu yang harus diingat. Body yang berubah satu
karakter setelah user menyetujui draft juga ditolak.

Exit code: `0` ok, `1` usage, `2` input, `3` identitas, `4` receipt, `5` Slack API,
`6` token/account belum siap.

## Setup

Mode `draft` langsung jalan. Untuk `send`, lihat [SETUP.md](SETUP.md) -- langkah
OAuth-nya **harus dijalankan pemilik akun Slack itu sendiri**.

## Test

```bash
node test/run.js
```

33 test, tanpa jaringan dan tanpa token nyata (fetch dan pembaca Keychain
disuntik). Yang diuji terutama keempat pengaman di atas, plus normalisasi mrkdwn
dan konversi `p1784788621208259` -> `1784788621.208259`.

## Isi

| File | Isi |
|---|---|
| `bin/slack-as-me` | shim, memanggil `lib/cli.js` |
| `lib/cli.js` | subcommand + keempat pengaman |
| `lib/slack.js` | wrapper Web API + allowlist anti-penyamaran |
| `lib/keychain.js` | token via `/usr/bin/security`, stdin-only |
| `lib/receipt.js` | bukti draft |
| `lib/mrkdwn.js` | normalisasi format Slack |
| `lib/target.js` | parse link arsip / channel ID / `#nama` |
| `lib/config.js` | account default (non-rahasia) |

Tidak ada dependency npm; butuh Node 18+ (`fetch` bawaan) dan macOS untuk
Keychain + clipboard.

## Data di luar direktori ini

| Lokasi | Isi |
|---|---|
| Keychain, service `slack-as-me` | token (satu-satunya tempat token disimpan) |
| `~/.config/slack-as-me/config.json` | account default, tanpa rahasia |
| `~/.cache/slack-as-me/drafts/` | isi draft |
| `~/.cache/slack-as-me/receipts/` | metadata receipt |

Draft dan receipt memuat isi pesan, jadi bisa berisi hal internal; keduanya
`0600` dan di luar direktori proyek. Direktori proyek ini sendiri tidak memuat
kredensial apa pun.

## Catatan: `--confirm-as` pakai user ID, bukan email

`slack-as-me doctor` dan `whoami` selalu mencetak nilai yang sah untuk token
yang sedang terpasang, beserta alasannya kalau email tidak tersedia.

Di sebagian workspace (termasuk Qiscus Tech) `users.info` menolak dengan
`user_not_found` walau scope `users:read` dan `users:read.email` sudah diberikan,
sehingga email tidak bisa diambil. `whoami` akan menampilkan handle + user ID saja.

Pakai **user ID** yang dicetak `whoami` untuk `--confirm-as` (mis. `U01DGERLBQU`).
Handle (`fathullah`) juga cocok. Ini justru pengikat yang lebih kuat daripada email:
user ID tidak berubah kalau email atau nama tampilan diganti.

## Penanda "sent by Claude Code (AI)"

Atas permintaan TL, setiap pesan yang dikirim lewat tool ini ditutup dengan baris
`_sent by Claude Code (AI)_` supaya pembaca tahu pesan dikirim oleh agen AI, bukan diketik
manusia. Penanda ditempel di `draft` dan `send`/`schedule` lewat jalur yang sama, jadi
receipt draft tetap cocok dan penanda terlihat di draf sebelum dikirim.

- Ganti teks: `SLACK_AS_ME_SIGNATURE="_sent by Claude (AI)_"`.
- Mati: `--no-signature`. **Hanya untuk operator manusia** yang mengetik pesannya sendiri;
  agen AI wajib membiarkan penanda.
- Tidak digandakan bila isi pesan sudah memuatnya. Berlaku juga untuk komentar lampiran (`--attach`).
