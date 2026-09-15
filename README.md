# Fingerspot R6 Listener

Listener Node.js untuk perangkat Fingerspot R6/OEM yang menggunakan keluarga protokol **BS Attendance/Access Control SDK**.

Protokol ini memakai HTTP `POST` dengan header seperti:

- `request_code: realtime_glog` — log absensi real-time
- `request_code: realtime_enroll_data` — data user/biometrik/foto saat enrollment
- `request_code: receive_cmd` — polling perintah dari mesin
- `request_code: send_cmd_result` — hasil eksekusi perintah
- `dev_id` — ID/serial perangkat
- `trans_id` — ID transaksi

## Menjalankan

1. Salin `.env.example` ke `.env` dan sesuaikan nilainya jika diperlukan:
   ```powershell
   cp .env.example .env
   ```

2. Jalankan server:
   ```powershell
   npm install
   node listener.js
   ```

Listener berjalan di port yang ditentukan di `.env` (default `9001`). Arahkan server/IP pada mesin ke komputer yang menjalankan listener dan port tersebut.

Jika `LOCAL_API_KEY` diatur pada `.env`, pastikan header `X-API-Key` dikirim saat memanggil endpoint API lokal.

## API lokal milik aplikasi

Endpoint berikut dibuat dan dilayani oleh listener ini. Tidak ada request ke API/cloud Fingerspot.

### 1. Ambil log attendance

`GET /api/log_att` membaca log yang sudah diterima dan disimpan di database lokal:

```http
GET http://127.0.0.1:9001/api/log_att?device_id=9FCE62DB60E142A7&start_date=2026-09-15&end_date=2026-09-15&limit=100
X-API-Key: ganti-dengan-key-kuat
```

Filter yang tersedia: `device_id`, `user_id`, `start_date`, `end_date`, dan `limit` (maksimal 1000).

Untuk meminta mesin mengirim log historis ke listener, gunakan `POST` pada path yang sama. Mesin akan mengambil command `GET_LOG_DATA` pada polling berikutnya, kemudian log masuk ke `attendance_logs`:

```http
POST http://127.0.0.1:9001/api/log_att
Content-Type: application/json
X-API-Key: ganti-dengan-key-kuat

{
  "device_id": "9FCE62DB60E142A7",
  "begin_time": "20260915000000",
  "end_time": "20260915235959"
}
```

Responsnya `202` dan berisi `command_id`.

### 2. Daftar employee

```http
GET http://127.0.0.1:9001/api/employees?device_id=9FCE62DB60E142A7
X-API-Key: ganti-dengan-key-kuat
```

Data dibaca dari tabel `employees` lokal.

### 3. Hapus employee

```http
DELETE http://127.0.0.1:9001/api/employees/2?device_id=9FCE62DB60E142A7
X-API-Key: ganti-dengan-key-kuat
```

Employee dihapus dari database lokal dan command `DELETE_USER` dimasukkan ke antrean mesin.

## API lokal lainnya

### Healthcheck

```http
GET http://127.0.0.1:9001/health
```

### Manajemen User / Karyawan

Endpoint untuk mengelola user di database server sekaligus mensinkronkan perintah (`SET_USER_INFO` / `DELETE_USER`) ke mesin absensi.

#### 1. Menampilkan Daftar User
```http
GET http://127.0.0.1:9001/api/users
X-API-Key: ganti-dengan-key-kuat
```

#### 2. Menambah User Baru (Add User)
```http
POST http://127.0.0.1:9001/api/users
Content-Type: application/json
X-API-Key: ganti-dengan-key-kuat

{
  "device_id": "9FCE62DB60E142A7",
  "user_id": "2",
  "name": "BUDI",
  "privilege": 0
}
```
*Atau bisa juga memanggil `POST /api/users/add` atau `POST /api/employees`.*

Field biometrik bersifat opsional:
- Template biometrik base64 dikirim sebagai `templates` (array of `{ "backup_number": 0, "base64": "..." }`).
- Foto dapat dikirim sebagai `photo_base64`.

#### 3. Mengedit Data User (Edit User)
```http
PUT http://127.0.0.1:9001/api/users/2
Content-Type: application/json
X-API-Key: ganti-dengan-key-kuat

{
  "device_id": "9FCE62DB60E142A7",
  "name": "BUDI SANTOSO",
  "privilege": 0
}
```
*Atau bisa juga memanggil `POST /api/users/edit` dengan `user_id` di dalam JSON body.*

#### 4. Menghapus User (Delete User)
```http
DELETE http://127.0.0.1:9001/api/users/2?device_id=9FCE62DB60E142A7
X-API-Key: ganti-dengan-key-kuat
```
*Atau memanggil `POST /api/users/delete` dengan body `{ "user_id": "2", "device_id": "9FCE62DB60E142A7" }`.*

### Mengirim command ke mesin

Setiap perintah memiliki API endpoint khusus sendiri di bawah `/api/commands/<command>` (dapat menggunakan format kebab-case, snake_case, atau uppercase). Selain itu, endpoint umum `POST /api/commands` juga tetap dapat digunakan.

Contoh menggunakan endpoint khusus:

```http
POST http://127.0.0.1:9001/api/commands/get-user-info
Content-Type: application/json
X-API-Key: ganti-dengan-key-kuat

{
  "device_id": "9FCE62DB60E142A7",
  "user_id": "1"
}
```

Daftar endpoint khusus & parameter yang didukung:

| Command | Dedicated Endpoint | Body / Parameter JSON |
|---|---|---|
| `GET_USER_ID_LIST` | `POST /api/commands/get-user-id-list` | `device_id` (opsional) |
| `GET_USER_INFO` | `POST /api/commands/get-user-info` | `device_id`, `user_id` (wajib) |
| `GET_LOG_DATA` | `POST /api/commands/get-log-data` | `device_id`, opsional `begin_time`, `end_time` (`YYYYMMDDhhmmss`) |
| `SET_TIME` | `POST /api/commands/set-time` | `device_id`, opsional `time` (`YYYYMMDDhhmmss`) |
| `GET_DEVICE_STATUS` | `POST /api/commands/get-device-status` | `device_id` (opsional) |
| `SET_FK_NAME` | `POST /api/commands/set-fk-name` | `device_id`, `fk_name` (wajib) |
| `RESET_FK` | `POST /api/commands/reset-fk` | `device_id` (opsional) |
| `SET_TIMEZONE` | `POST /api/commands/set-timezone` | `device_id`, `TimeZone_No` (wajib) |
| `GET_TIMEZONE` | `POST /api/commands/get-timezone` | `device_id` (opsional) |
| `SET_USER_PASSTIME` | `POST /api/commands/set-user-passtime` | `device_id`, `user_id` (wajib), jadwal akses |
| `GET_USER_PASSTIME` | `POST /api/commands/get-user-passtime` | `device_id`, `user_id` (wajib) |
| `SET_DEVICE_SETTING` | `POST /api/commands/set-device-setting` | `device_id`, parameter setting |
| `DELETE_USER` | `POST /api/commands/delete-user` | `device_id`, `user_id` (wajib) |
| `GET_ALL_USER_INFO` | `POST /api/commands/get-all-user-info` | `device_id` (opsional) |

Atau menggunakan endpoint umum `POST /api/commands`:

```http
POST http://127.0.0.1:9001/api/commands
Content-Type: application/json
X-API-Key: ganti-dengan-key-kuat

{
  "command": "GET_USER_INFO",
  "device_id": "9FCE62DB60E142A7",
  "params": { "user_id": "1" }
}
```

Response adalah HTTP `202` dengan `command_id`. Mesin mengambil command pada polling berikutnya.

Status command:

```http
GET http://127.0.0.1:9001/api/commands/{command_id}
X-API-Key: ganti-dengan-key-kuat
```

Response `send_cmd_result` menyimpan `returnCode`, `block`, ringkasan JSON, dan ukuran data binary. Isi template/foto tidak dikembalikan atau ditulis ke log.

## Format protokol

Payload command dengan data JSON dikirim sebagai:

```text
4-byte little-endian panjang JSON
JSON UTF-8
4-byte little-endian panjang binary pertama
binary pertama
...
```

Parser inbound mencari JSON berdasarkan kedalaman kurung kurawal sehingga tetap aman ketika payload dilanjutkan binary template atau foto.

Command massal/destruktif seperti `CLEAR_ENROLL_DATA`, `CLEAR_LOG_DATA`, `CLEAR_MANAGER`, `UPDATE_FIRMWARE`, dan `SET_DOOR_STATUS` sengaja tidak dibuka melalui API umum.

## Referensi

- [BS Attendance/Access Control SDK Manual](https://pdfcoffee.com/bs-sdk-mnaual-pdf-free.html)
- [Realand SDK Download](https://realandtec.com/download/sdk-download_c0005)
- [Fingerspot Developer API](https://developer.fingerspot.io/docs/en/getting-started/)
