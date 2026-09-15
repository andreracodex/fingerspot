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

Jika `FINGERSPOT_API_KEY` diatur pada `.env`, pastikan header `X-API-Key` dikirim saat memanggil API endpoint non-lokal.

## API lokal

### Healthcheck

```http
GET http://127.0.0.1:9001/health
```

### Menambah atau sinkronisasi user

```http
POST http://127.0.0.1:9001/api/employees
Content-Type: application/json
X-API-Key: ganti-dengan-key-kuat

{
  "device_id": "9FCE62DB60E142A7",
  "user_id": "2",
  "name": "BUDI",
  "privilege": 0
}
```

Field biometrik bersifat opsional. Jika digunakan, template harus berupa base64 dan dikirim sebagai `templates` dengan `backup_number`; foto dapat dikirim sebagai `photo_base64`.

### Mengirim command ke mesin

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

Response adalah `202` dengan `command_id`. Mesin mengambil command pada polling berikutnya.

Command yang didukung:

| Command | Parameter |
|---|---|
| `GET_USER_ID_LIST` | tidak ada |
| `GET_USER_INFO` | `user_id` |
| `GET_LOG_DATA` | opsional `begin_time`, `end_time` dengan format `YYYYMMDDhhmmss` |
| `SET_TIME` | opsional `time`; default waktu server Asia/Jakarta |
| `GET_DEVICE_STATUS` | tidak ada |
| `SET_FK_NAME` | `fk_name` |
| `RESET_FK` | tidak ada |
| `SET_TIMEZONE` | struktur zona waktu dari SDK |
| `GET_TIMEZONE` | tidak ada |
| `SET_USER_PASSTIME` | `user_id` dan jadwal akses |
| `GET_USER_PASSTIME` | `user_id` |
| `SET_DEVICE_SETTING` | struktur setting akses kontrol |
| `DELETE_USER` | `user_id` |
| `GET_ALL_USER_INFO` | tidak ada |

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
