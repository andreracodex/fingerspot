require("dotenv").config();
const http = require("http");
const mysql = require("mysql2/promise");

const PORT = parseInt(process.env.PORT || "9001", 10);
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Jakarta";
const DEVICE_TIME_OFFSET = process.env.DEVICE_TIME_OFFSET || "+07:00";
const MAX_DEVICE_TIME_SKEW_MS = parseInt(process.env.MAX_DEVICE_TIME_SKEW_MS || String(36 * 60 * 60 * 1000), 10);
const DUPLICATE_WINDOW_MS = parseInt(process.env.DUPLICATE_WINDOW_MS || String(30 * 1000), 10);
const COMMAND_QUEUE_LIMIT = parseInt(process.env.COMMAND_QUEUE_LIMIT || "100", 10);
const API_KEY = process.env.FINGERSPOT_API_KEY || "";

const DOCUMENTED_COMMANDS = new Set([
    "GET_USER_ID_LIST",
    "GET_USER_INFO",
    "GET_LOG_DATA",
    "SET_TIME",
    "GET_DEVICE_STATUS",
    "SET_FK_NAME",
    "RESET_FK",
    "SET_TIMEZONE",
    "GET_TIMEZONE",
    "SET_USER_PASSTIME",
    "GET_USER_PASSTIME",
    "SET_DEVICE_SETTING",
    "DELETE_USER",
    "GET_ALL_USER_INFO"
]);

const recentAttendanceEvents = new Map();
const commandQueue = [];
const commandResults = new Map();

/**
 * ============================================================
 * DATABASE
 * ============================================================
 */

const db = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: parseInt(process.env.DB_PORT || "3308", 10),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "mypassrootonly",
    database: process.env.DB_NAME || "fingerspot",

    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || "10", 10),
    queueLimit: 0,

    charset: "utf8mb4"
});

/**
 * ============================================================
 * UTILITIES
 * ============================================================
 */

function cleanIP(ip) {
    if (!ip) return null;

    return ip.replace(/^::ffff:/, "");
}

function normalizeDeviceScope(deviceId) {
    return safeString(deviceId) || "";
}

function safeString(value) {
    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }

    const result = String(value).trim();

    return result === "" ? null : result;
}

function formatDeviceTime(value) {
    const str = safeString(value);

    if (!str) return null;

    let match = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);

    if (!match) {
        match = str.match(/^(\d{4})[-](\d{2})[-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    }

    if (!match) return null;

    const [, year, month, day, hour, minute, second] = match;
    const validationDate = new Date(
        Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second)
        )
    );

    if (
        Number(year) < 2000 ||
        validationDate.getUTCFullYear() !== Number(year) ||
        validationDate.getUTCMonth() !== Number(month) - 1 ||
        validationDate.getUTCDate() !== Number(day) ||
        validationDate.getUTCHours() !== Number(hour) ||
        validationDate.getUTCMinutes() !== Number(minute) ||
        validationDate.getUTCSeconds() !== Number(second)
    ) {
        return null;
    }

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/**
 * ISO -> MySQL DATETIME
 */
function mysqlDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23"
        }
    ).formatToParts(date);

    const values = Object.fromEntries(
        parts
            .filter(part => part.type !== "literal")
            .map(part => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day} ` +
        `${values.hour}:${values.minute}:${values.second}`;
}

function resolveDeviceTime(rawValue, receivedAt) {
    const formatted = formatDeviceTime(rawValue);

    if (!formatted) {
        return {
            value: receivedAt,
            source: "SERVER_FALLBACK"
        };
    }

    const deviceDate = new Date(
        `${formatted.replace(" ", "T")}${DEVICE_TIME_OFFSET}`
    );
    const receivedDate = new Date(
        `${receivedAt.replace(" ", "T")}${DEVICE_TIME_OFFSET}`
    );

    if (
        Number.isNaN(deviceDate.getTime()) ||
        Math.abs(deviceDate.getTime() - receivedDate.getTime()) > MAX_DEVICE_TIME_SKEW_MS
    ) {
        return {
            value: receivedAt,
            source: "SERVER_FALLBACK"
        };
    }

    return {
        value: formatted,
        source: "DEVICE"
    };
}

function sendJson(res, statusCode, payload) {
    if (res.headersSent) return;

    const body = JSON.stringify(payload);

    res.writeHead(
        statusCode,
        {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "Connection": "close"
        }
    );

    res.end(body);
}

function sendDeviceAck(res, transId = null, options = {}) {
    if (res.headersSent) return;

    const body = options.body || Buffer.alloc(0);
    const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Connection": "close",
        "response_code": "OK"
    };

    if (transId) {
        headers.trans_id = transId;
    }

    if (options.cmdCode) {
        headers.cmd_code = options.cmdCode;
    }

    res.writeHead(200, headers);
    res.end(body);
}

function formatCommandBody(bodyValue, binaryBlobs = []) {
    if (bodyValue === null || bodyValue === undefined) {
        return Buffer.alloc(0);
    }

    const json = Buffer.from(
        JSON.stringify(bodyValue),
        "utf8"
    );
    const prefix = Buffer.alloc(4);

    prefix.writeUInt32LE(json.length, 0);

    const parts = [prefix, json];

    for (const blob of binaryBlobs) {
        const length = Buffer.alloc(4);
        length.writeUInt32LE(blob.length, 0);
        parts.push(length, blob);
    }

    return Buffer.concat(parts);
}

function compactDeviceTime(date = new Date()) {
    return mysqlDate(date).replace(/[- :]/g, "");
}

function validateCompactDeviceTime(value, fieldName) {
    const text = safeString(value);

    if (!text || !/^\d{14}$/.test(text)) {
        throw new Error(`${fieldName} harus berformat YYYYMMDDhhmmss`);
    }

    if (!formatDeviceTime(text)) {
        throw new Error(`${fieldName} bukan tanggal/waktu yang valid`);
    }

    return text;
}

function commandBodyValue(payload) {
    if (payload && payload.params !== undefined && typeof payload.params === "object" && payload.params !== null) {
        return payload.params;
    }
    if (payload && payload.body !== undefined && typeof payload.body === "object" && payload.body !== null) {
        return payload.body;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {};
    }

    const { device_id, deviceId, dev_id, command, cmd_code, ...rest } = payload;
    return rest;
}

function requiredCommandUserId(body) {
    const userId = safeString(
        body.user_id ??
        body.userId ??
        body.pin
    );

    if (!userId) {
        throw new Error("user_id wajib diisi untuk command ini");
    }

    return userId;
}

function buildDocumentedCommand(payload, overrideCommand = null) {
    const rawCommand = overrideCommand || payload?.command || payload?.cmd_code;
    const command = safeString(rawCommand)?.toUpperCase()?.replace(/-/g, "_");

    if (!command || !DOCUMENTED_COMMANDS.has(command)) {
        throw new Error(
            `command tidak didukung. Pilihan: ${[...DOCUMENTED_COMMANDS].join(", ")}`
        );
    }

    const safePayload = (payload && typeof payload === "object" && !Array.isArray(payload))
        ? payload
        : {};

    const targetDeviceId = safeString(
        safePayload.device_id ??
        safePayload.deviceId ??
        safePayload.dev_id
    );

    let body = commandBodyValue(safePayload);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("params/body command harus berupa object JSON");
    }

    body = { ...body };

    switch (command) {
        case "GET_USER_INFO":
        case "DELETE_USER":
        case "GET_USER_PASSTIME":
            body = { user_id: requiredCommandUserId(body) };
            break;

        case "GET_LOG_DATA":
            body = {};
            if (safePayload.params?.begin_time !== undefined || safePayload.body?.begin_time !== undefined || safePayload.begin_time !== undefined) {
                body.begin_time = validateCompactDeviceTime(
                    safePayload.params?.begin_time ?? safePayload.body?.begin_time ?? safePayload.begin_time,
                    "begin_time"
                );
            }
            if (safePayload.params?.end_time !== undefined || safePayload.body?.end_time !== undefined || safePayload.end_time !== undefined) {
                body.end_time = validateCompactDeviceTime(
                    safePayload.params?.end_time ?? safePayload.body?.end_time ?? safePayload.end_time,
                    "end_time"
                );
            }
            break;

        case "SET_TIME":
            body = {
                time: validateCompactDeviceTime(
                    body.time || compactDeviceTime(),
                    "time"
                )
            };
            break;

        case "SET_FK_NAME":
            body = { fk_name: safeString(body.fk_name ?? body.name) };
            if (!body.fk_name) throw new Error("fk_name wajib diisi");
            break;

        case "SET_TIMEZONE":
            if (body.TimeZone_No === undefined && body.timezone_no === undefined) {
                throw new Error("TimeZone_No wajib diisi");
            }
            if (body.timezone_no !== undefined && body.TimeZone_No === undefined) {
                body.TimeZone_No = body.timezone_no;
                delete body.timezone_no;
            }
            break;

        case "SET_USER_PASSTIME":
            body = {
                user_id: requiredCommandUserId(body),
                Valide_Date_start: body.Valide_Date_start ?? body.valid_date_start ?? "",
                Valide_Date_end: body.Valide_Date_end ?? body.valid_date_end ?? "",
                Week_TimeZone_No: body.Week_TimeZone_No ?? body.week_timezone_no ?? []
            };
            break;

        case "SET_DEVICE_SETTING":
            if (Object.keys(body).length === 0) {
                throw new Error("params wajib diisi untuk SET_DEVICE_SETTING");
            }
            break;

        case "GET_USER_ID_LIST":
        case "GET_DEVICE_STATUS":
        case "GET_ALL_USER_INFO":
        case "GET_TIMEZONE":
        case "RESET_FK":
            body = {};
            break;

        default:
            break;
    }

    return {
        cmd_code: command,
        targetDeviceId,
        body: Object.keys(body).length > 0 ? body : null,
        binaryBlobs: []
    };
}

function queueCommand(command) {
    if (commandQueue.length >= COMMAND_QUEUE_LIMIT) {
        throw new Error("command queue penuh");
    }

    const id = `${command.cmd_code.toLowerCase()}-${Date.now()}-${commandQueue.length + 1}`;
    const queued = {
        ...command,
        id,
        enqueuedAt: mysqlDate()
    };

    commandQueue.push(queued);
    commandResults.set(
        id,
        {
            id,
            status: "queued",
            command: command.cmd_code,
            deviceId: command.targetDeviceId,
            params: command.body,
            enqueuedAt: queued.enqueuedAt
        }
    );

    return queued;
}

function parseProtocolResult(buffer) {
    if (!buffer || buffer.length === 0) {
        return { data: null, binaryBlobs: [] };
    }

    let jsonStart = 0;
    let jsonLength = null;

    if (buffer.length >= 4) {
        const candidateLength = buffer.readUInt32LE(0);
        if (candidateLength > 1 && candidateLength <= buffer.length - 4) {
            const candidate = buffer.subarray(4, 4 + candidateLength);
            try {
                JSON.parse(candidate.toString("utf8"));
                jsonStart = 4;
                jsonLength = candidateLength;
            } catch {
                // Fallback to an unframed JSON body below.
            }
        }
    }

    if (jsonLength === null) {
        const data = extractJsonFromBuffer(buffer);
        return { data, binaryBlobs: [] };
    }

    const data = JSON.parse(
        buffer.subarray(jsonStart, jsonStart + jsonLength).toString("utf8")
    );
    const binaryBlobs = [];
    let offset = jsonStart + jsonLength;

    while (offset + 4 <= buffer.length) {
        const length = buffer.readUInt32LE(offset);
        offset += 4;
        if (length > buffer.length - offset) break;
        binaryBlobs.push(buffer.subarray(offset, offset + length));
        offset += length;
    }

    return { data, binaryBlobs };
}

function summarizeProtocolResult(buffer) {
    const parsed = parseProtocolResult(buffer);
    return {
        data: sanitizeData(parsed.data),
        binary: parsed.binaryBlobs.map((blob, index) => ({
            index: index + 1,
            size: blob.length
        }))
    };
}

function extractJsonFromBuffer(buffer) {
    const text = buffer.toString("latin1");
    const start = text.indexOf("{");

    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index++) {
        const char = text[index];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (inString) {
            if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === "{") {
            depth++;
        } else if (char === "}") {
            depth--;

            if (depth === 0) {
                const jsonText = text.slice(start, index + 1);

                try {
                    return JSON.parse(
                        Buffer.from(jsonText, "latin1").toString("utf8")
                    );
                } catch {
                    return null;
                }
            }
        }
    }

    return null;
}

function decodeBase64(value) {
    const text = safeString(value);

    if (!text) return null;

    const normalized = text.replace(
        /^data:[^;]+;base64,/i,
        ""
    );

    try {
        const buffer = Buffer.from(normalized, "base64");

        return buffer.length > 0 ? buffer : null;
    } catch {
        return null;
    }
}

function buildSetUserInfoCommand(payload) {
    const userId = safeString(
        payload.user_id ??
        payload.userId ??
        payload.pin ??
        payload.employee_id ??
        payload.employeeId
    );
    const userName = safeString(
        payload.user_name ??
        payload.name ??
        payload.employee_name ??
        payload.employeeName
    );
    const privilegeValue =
        payload.user_privilege ??
        payload.privilege ??
        0;
    const privilege = Number(privilegeValue);

    if (!userId) {
        throw new Error("user_id wajib diisi");
    }

    if (!userName) {
        throw new Error("name wajib diisi");
    }

    if (!Number.isInteger(privilege) || privilege < 0) {
        throw new Error("privilege harus bilangan bulat >= 0");
    }

    const binaryBlobs = [];
    const enrollDataArray = [];
    const templates = Array.isArray(payload.templates)
        ? payload.templates
        : Array.isArray(payload.enroll_data_array)
            ? payload.enroll_data_array
            : [];

    for (const template of templates) {
        const blob = decodeBase64(
            template?.base64 ??
            template?.data ??
            template?.template
        );

        if (!blob) {
            throw new Error("template biometrik harus base64 yang valid");
        }

        const backupNumber = Number(
            template.backup_number ??
            template.backupNumber ??
            template.finger_idx ??
            template.index ??
            0
        );

        if (!Number.isInteger(backupNumber) || backupNumber < 0) {
            throw new Error("backup_number template tidak valid");
        }

        binaryBlobs.push(blob);
        enrollDataArray.push({
            backup_number: backupNumber,
            enroll_data: `BIN_${binaryBlobs.length}`
        });
    }

    const photo = decodeBase64(
        payload.photo_base64 ??
        payload.photoBase64 ??
        payload.photo
    );
    let userPhoto = null;

    if (photo) {
        binaryBlobs.push(photo);
        userPhoto = `BIN_${binaryBlobs.length}`;
    }

    return {
        targetDeviceId: safeString(
            payload.device_id ??
            payload.deviceId
        ),
        body: {
            user_id: userId,
            user_name: userName,
            user_privilege: privilege,
            enroll_data_array: enrollDataArray,
            user_photo: userPhoto || ""
        },
        binaryBlobs
    };
}

function dequeueCommand(deviceId) {
    const index = commandQueue.findIndex(command =>
        !command.targetDeviceId ||
        command.targetDeviceId === deviceId
    );

    if (index === -1) return null;

    const [command] = commandQueue.splice(index, 1);

    commandResults.set(
        command.id,
        {
            id: command.id,
            status: "dispatched",
            deviceId,
            command: command.cmd_code,
            enqueuedAt: command.enqueuedAt,
            dispatchedAt: mysqlDate()
        }
    );

    return command;
}

function isApiAuthorized(req) {
    if (!API_KEY) {
        const ip = cleanIP(
            req.socket.remoteAddress
        );

        return ip === "127.0.0.1" || ip === "::1";
    }

    return req.headers["x-api-key"] === API_KEY;
}

/**
 * ============================================================
 * SANITIZER
 * ============================================================
 *
 * Jangan pernah simpan:
 *
 * - gambar
 * - face template
 * - fingerprint template
 * - palm template
 */

function sanitizeData(data) {
    if (
        !data ||
        typeof data !== "object"
    ) {
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(
            item => sanitizeData(item)
        );
    }

    const result = {};

    for (
        const [key, value]
        of Object.entries(data)
    ) {
        const lowerKey =
            key.toLowerCase();

        if (
            lowerKey === "photo" ||
            lowerKey === "logphoto"
        ) {
            result[key] =
                "[PHOTO REMOVED]";

            continue;
        }

        if (lowerKey === "face") {
            result[key] =
                "[FACE TEMPLATE REMOVED]";

            continue;
        }

        if (lowerKey === "fps") {
            result[key] =
                "[FINGERPRINT TEMPLATE REMOVED]";

            continue;
        }

        if (lowerKey === "palm") {
            result[key] =
                "[PALM TEMPLATE REMOVED]";

            continue;
        }

        if (
            value &&
            typeof value === "object"
        ) {
            result[key] =
                sanitizeData(value);

            continue;
        }

        result[key] = value;
    }

    return result;
}

/**
 * ============================================================
 * RECURSIVE FIELD SEARCH
 * ============================================================
 */

function findValue(object, keys) {
    if (
        !object ||
        typeof object !== "object"
    ) {
        return null;
    }

    const targetKeys =
        keys.map(
            key => key.toLowerCase()
        );

    for (
        const [key, value]
        of Object.entries(object)
    ) {
        if (targetKeys.includes(key.toLowerCase())) {
            const normalized = safeString(value);

            if (normalized !== null) {
                return value;
            }
        }
    }

    for (
        const value
        of Object.values(object)
    ) {
        if (
            value &&
            typeof value === "object"
        ) {
            const result =
                findValue(
                    value,
                    keys
                );

            if (
                result !== null &&
                result !== undefined
            ) {
                return result;
            }
        }
    }

    return null;
}

/**
 * ============================================================
 * FIELD EXTRACTION
 * ============================================================
 */

function extractUserId(data) {
    return findValue(
        data,
        [
            "userId",
            "userid",
            "userID",
            "employeeId",
            "employeeID",
            "employeeNo",
            "employeeNumber",
            "pin",
            "uid",
            "enrollId",
            "enrollID"
        ]
    );
}

function extractName(data) {
    return findValue(
        data,
        [
            "name",
            "userName",
            "username",
            "employeeName"
        ]
    );
}

function extractTime(data) {
    return findValue(
        data,
        [
            "time",
            "datetime",
            "dateTime",
            "timestamp",
            "recordTime",
            "verifyTime"
        ]
    );
}

function extractCard(data) {
    return findValue(
        data,
        [
            "card",
            "cardNo",
            "cardNumber",
            "cardId",
            "cardID",
            "rfid",
            "rfidNo"
        ]
    );
}

function extractQR(data) {
    return findValue(
        data,
        [
            "qr",
            "qrCode",
            "qrcode",
            "barcode",
            "qrData"
        ]
    );
}

/**
 * ============================================================
 * AUTH METHOD
 * ============================================================
 */

function detectAuthMethod(data) {
    const value =
        findValue(
            data,
            [
                "verifyMode",
                "verifyType",
                "verifyMethod",

                "authMode",
                "authType",
                "authMethod",

                "credentialType",

                "identifyType",
                "identificationType",

                "recognitionType",

                "openType",

                "checkType",

                "method"
            ]
        );

    if (
        value === null ||
        value === undefined
    ) {
        return {
            method: "UNKNOWN",
            rawValue: null
        };
    }

    const rawValue =
        String(value);

    const text =
        rawValue.toLowerCase();

    if (
        text.includes("face") ||
        text.includes("facial")
    ) {
        return {
            method: "FACE",
            rawValue
        };
    }

    if (
        text.includes("palm") ||
        text.includes("vein")
    ) {
        return {
            method: "PALM",
            rawValue
        };
    }

    if (
        text.includes("finger") ||
        text.includes("fingerprint") ||
        text === "fp"
    ) {
        return {
            method: "FINGERPRINT",
            rawValue
        };
    }

    if (
        text.includes("card") ||
        text.includes("rfid") ||
        text.includes("nfc")
    ) {
        return {
            method: "CARD",
            rawValue
        };
    }

    if (
        text.includes("qr") ||
        text.includes("qrcode") ||
        text.includes("barcode")
    ) {
        return {
            method: "QR",
            rawValue
        };
    }

    return {
        method: "UNKNOWN",
        rawValue
    };
}

/**
 * ============================================================
 * REQUEST TYPE
 * ============================================================
 */

function classifyRequest(requestCode) {
    if (!requestCode) {
        return "UNKNOWN";
    }

    const code =
        String(requestCode)
            .toLowerCase();

    if (
        code.includes("enroll")
    ) {
        return "ENROLLMENT";
    }

    if (
        code.includes("glog") ||
        code.includes("log")
    ) {
        return "ACCESS_LOG";
    }

    return "OTHER";
}

function isDoorOnlyEvent(event) {
    const doorMode = safeString(event.doorMode);

    return (
        event.eventType === "ACCESS_LOG" &&
        !event.userId &&
        !event.name &&
        !event.cardNumber &&
        !event.hasQR &&
        event.authMethod === "UNKNOWN" &&
        Boolean(doorMode) &&
        /(^|_)(open|opened|hand_open)(_|$)/i.test(doorMode)
    );
}

function hasAttendanceIdentity(event) {
    return Boolean(
        event.userId ||
        event.name ||
        event.cardNumber ||
        event.hasQR ||
        event.authMethod !== "UNKNOWN"
    );
}

function classifyInboundEvent(event) {
    if (event.eventType !== "ACCESS_LOG") {
        return event.eventType;
    }

    return hasAttendanceIdentity(event)
        ? "ATT_LOG"
        : "DEVICE_MESSAGE";
}

function attendanceEventKey(event) {
    return JSON.stringify([
        event.deviceId,
        event.userId,
        event.name,
        event.rawDeviceTime,
        event.cardNumber,
        event.hasQR,
        event.authMethod,
        event.ioMode,
        event.doorMode
    ]);
}

function isDuplicateAttendance(event) {
    const now = Date.now();

    for (const [key, timestamp] of recentAttendanceEvents) {
        if (now - timestamp > DUPLICATE_WINDOW_MS) {
            recentAttendanceEvents.delete(key);
        }
    }

    const key = attendanceEventKey(event);
    const previous = recentAttendanceEvents.get(key);

    if (previous && now - previous <= DUPLICATE_WINDOW_MS) {
        return true;
    }

    recentAttendanceEvents.set(key, now);

    return false;
}

/**
 * ============================================================
 * DATABASE INSERT
 * ============================================================
 */

async function saveAttendance(event) {

    const sql = `
        INSERT INTO attendance_logs
        (
            device_id,
            device_model,

            user_id,
            employee_name,

            auth_method,

            device_time,
            received_at,

            io_mode,
            door_mode,

            request_code,
            transaction_id,

            card_number,
            has_qr,

            ip_address,

            raw_data
        )
        VALUES
        (
            ?, ?,
            ?, ?,
            ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?,
            ?
        )
    `;

    const rawData =
        JSON.stringify(
            event.rawData || {}
        );

    const values = [
        event.deviceId,
        event.deviceModel,

        event.userId,
        event.name,

        event.authMethod,

        event.deviceTime,
        event.receivedAt,

        event.ioMode,
        event.doorMode,

        event.requestCode,
        event.transaction,

        event.cardNumber,
        event.hasQR ? 1 : 0,

        event.ip,

        rawData
    ];

    const [result] =
        await db.execute(
            sql,
            values
        );

    return result.insertId;
}

async function saveDeviceMessage(event) {
    const sql = `
        INSERT INTO device_messages
        (
            device_id,
            device_model,
            message_type,
            request_code,
            transaction_id,
            user_id,
            employee_name,
            device_time,
            received_at,
            io_mode,
            door_mode,
            ip_address,
            raw_data
        )
        VALUES
        (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
    `;

    const values = [
        event.deviceId,
        event.deviceModel,
        event.eventType,
        event.requestCode,
        event.transaction,
        event.userId,
        event.name,
        event.deviceTime,
        event.receivedAt,
        event.ioMode,
        event.doorMode,
        event.ip,
        JSON.stringify(event.rawData || {})
    ];

    const [result] = await db.execute(sql, values);

    return result.insertId;
}

async function backfillAttendanceName(deviceId, userId, employeeName) {
    const normalizedDeviceId = normalizeDeviceScope(deviceId);
    const normalizedUserId = safeString(userId);
    const normalizedName = safeString(employeeName);

    if (!normalizedUserId || !normalizedName) return;

    if (normalizedDeviceId) {
        await db.execute(
            `
                UPDATE attendance_logs
                SET employee_name = ?
                WHERE device_id = ?
                  AND user_id = ?
                  AND (employee_name IS NULL OR employee_name = '')
            `,
            [normalizedName, normalizedDeviceId, normalizedUserId]
        );

        return;
    }

    await db.execute(
        `
            UPDATE attendance_logs
            SET employee_name = ?
            WHERE user_id = ?
              AND (employee_name IS NULL OR employee_name = '')
        `,
        [normalizedName, normalizedUserId]
    );
}

async function upsertEmployee({
    deviceId,
    userId,
    employeeName,
    privilege = 0,
    source = "DEVICE"
}) {
    const normalizedDeviceId = normalizeDeviceScope(deviceId);
    const normalizedUserId = safeString(userId);
    const normalizedName = safeString(employeeName);
    const normalizedPrivilege = Number.isInteger(Number(privilege))
        ? Number(privilege)
        : 0;

    if (!normalizedUserId || !normalizedName) return false;

    await db.execute(
        `
            INSERT INTO employees
            (
                device_id,
                user_id,
                employee_name,
                privilege,
                source
            )
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                employee_name = VALUES(employee_name),
                privilege = VALUES(privilege),
                source = VALUES(source),
                updated_at = CURRENT_TIMESTAMP
        `,
        [
            normalizedDeviceId,
            normalizedUserId,
            normalizedName,
            normalizedPrivilege,
            source
        ]
    );

    await backfillAttendanceName(
        normalizedDeviceId,
        normalizedUserId,
        normalizedName
    );

    return true;
}

async function findEmployeeName(deviceId, userId) {
    const normalizedUserId = safeString(userId);

    if (!normalizedUserId) return null;

    const normalizedDeviceId = normalizeDeviceScope(deviceId);
    const [rows] = await db.execute(
        `
            SELECT employee_name
            FROM employees
            WHERE user_id = ?
              AND device_id IN (?, '')
            ORDER BY
                CASE WHEN device_id = ? THEN 0 ELSE 1 END,
                updated_at DESC
            LIMIT 1
        `,
        [normalizedUserId, normalizedDeviceId, normalizedDeviceId]
    );

    return rows.length > 0
        ? safeString(rows[0].employee_name)
        : null;
}

/**
 * ============================================================
 * CONSOLE
 * ============================================================
 */

function printEvent(event) {
    const parts = [
        event.receivedAt,

        event.requestCode ||
            "NO_REQUEST_CODE",

        `type=${event.eventType}`,

        `device=${event.deviceId || "-"}`,

        `user=${event.userId || "-"}`,

        `name=${event.name || "-"}`,

        `method=${event.authMethod}`,

        `time=${event.deviceTime || "-"}`
    ];

    if (event.deviceTimeSource === "SERVER_FALLBACK") {
        parts.push("time_source=SERVER");
    }

    if (
        event.ioMode !== null &&
        event.ioMode !== undefined
    ) {
        parts.push(
            `io=${event.ioMode}`
        );
    }

    if (event.doorMode) {
        parts.push(
            `door=${event.doorMode}`
        );
    }

    if (event.cardNumber) {
        parts.push(
            `card=${event.cardNumber}`
        );
    }

    if (event.hasQR) {
        parts.push(
            "QR=YES"
        );
    }

    if (event.hasPhoto) {
        parts.push(
            "PHOTO=YES"
        );
    }

    console.log(
        parts.join(" | ")
    );
}

/**
 * ============================================================
 * RESPONSE
 * ============================================================
 */

function sendOK(res) {
    sendJson(res, 200, { status: "success" });
}

function sendRequestAck(res, requestCode, transId) {
    if (requestCode && requestCode !== "healthcheck") {
        sendDeviceAck(res, transId);
        return;
    }

    sendOK(res);
}

/**
 * ============================================================
 * HTTP SERVER
 * ============================================================
 */

const server =
    http.createServer(
        (req, res) => {

            const chunks = [];

            req.on(
                "data",
                chunk => {
                    chunks.push(chunk);
                }
            );

            req.on(
                "error",
                error => {
                    console.error(
                        "REQUEST ERROR:",
                        error.message
                    );
                }
            );

            req.on(
                "end",
                async () => {

                    // Nilai ini juga dibutuhkan oleh blok catch untuk mengirim
                    // ACK meskipun proses parsing atau database gagal.
                    let requestCode = null;
                    let transaction = null;

                    try {

                        /**
                         * ============================
                         * BASIC REQUEST
                         * ============================
                         */

                        const receivedAt =
                            mysqlDate();

                        const buffer =
                            Buffer.concat(
                                chunks
                            );

                        const body =
                            buffer.toString(
                                "utf8"
                            );

                        const headers =
                            req.headers;

                        const ip =
                            cleanIP(
                                req.socket
                                    .remoteAddress
                            );

                        requestCode =
                            headers[
                                "request_code"
                            ] || null;

                        transaction =
                            headers[
                                "trans_id"
                            ] || null;

                        const deviceId =
                            headers[
                                "dev_id"
                            ] || null;

                        const deviceModel =
                            headers[
                                "dev_model"
                            ] || null;

                        const pathname = String(
                            req.url || "/"
                        ).split("?")[0];

                        const isEmployeeApi =
                            req.method === "POST" &&
                            pathname === "/api/employees";

                        const isGenericCommandApi =
                            req.method === "POST" &&
                            pathname === "/api/commands";

                        const isSpecificCommandApi =
                            req.method === "POST" &&
                            pathname.startsWith("/api/commands/") &&
                            pathname !== "/api/commands";

                        const isCommandApi =
                            isGenericCommandApi || isSpecificCommandApi;

                        const commandStatusPrefix =
                            "/api/commands/";

                        /**
                         * ============================
                         * PARSE JSON
                         * ============================
                         */

                        const parsedData =
                            extractJsonFromBuffer(
                                buffer
                            );

                        if (
                            req.method === "GET" &&
                            pathname === "/health"
                        ) {
                            sendJson(
                                res,
                                200,
                                {
                                    status: "ok",
                                    port: PORT,
                                    queue_length: commandQueue.length,
                                    supported_commands: [...DOCUMENTED_COMMANDS],
                                    time: receivedAt
                                }
                            );

                            return;
                        }

                        if (isCommandApi) {
                            if (!isApiAuthorized(req)) {
                                sendJson(
                                    res,
                                    401,
                                    { error: "unauthorized" }
                                );

                                return;
                            }

                            if (!parsedData || typeof parsedData !== "object") {
                                sendJson(
                                    res,
                                    400,
                                    { error: "JSON body tidak valid" }
                                );

                                return;
                            }

                            const payloadData = parsedData || {};

                            let overrideCommand = null;
                            if (isSpecificCommandApi) {
                                const commandSlug = pathname.slice("/api/commands/".length);
                                overrideCommand = commandSlug;
                            }

                            try {
                                const command =
                                    buildDocumentedCommand(payloadData, overrideCommand);
                                const queued = queueCommand(command);

                                sendJson(
                                    res,
                                    202,
                                    {
                                        status: "queued",
                                        command_id: queued.id,
                                        command: queued.cmd_code,
                                        device_id: queued.targetDeviceId,
                                        queue_length: commandQueue.length
                                    }
                                );
                            } catch (commandError) {
                                sendJson(
                                    res,
                                    commandError.message === "command queue penuh"
                                        ? 429
                                        : 400,
                                    { error: commandError.message }
                                );
                            }

                            return;
                        }

                        if (isEmployeeApi) {
                            if (!isApiAuthorized(req)) {
                                sendJson(
                                    res,
                                    401,
                                    { error: "unauthorized" }
                                );

                                return;
                            }

                            if (!parsedData || typeof parsedData !== "object") {
                                sendJson(
                                    res,
                                    400,
                                    { error: "JSON body tidak valid" }
                                );

                                return;
                            }

                            if (commandQueue.length >= COMMAND_QUEUE_LIMIT) {
                                sendJson(
                                    res,
                                    429,
                                    { error: "command queue penuh" }
                                );

                                return;
                            }

                            try {
                                const command =
                                    buildSetUserInfoCommand(
                                        parsedData
                                    );

                                await upsertEmployee({
                                    deviceId:
                                        command.targetDeviceId,
                                    userId:
                                        command.body.user_id,
                                    employeeName:
                                        command.body.user_name,
                                    privilege:
                                        command.body.user_privilege,
                                    source: "API"
                                });

                                const commandId =
                                    `set-user-${Date.now()}-${commandQueue.length + 1}`;

                                commandQueue.push({
                                    id: commandId,
                                    cmd_code: "SET_USER_INFO",
                                    targetDeviceId:
                                        command.targetDeviceId,
                                    body: command.body,
                                    binaryBlobs:
                                        command.binaryBlobs,
                                    enqueuedAt: mysqlDate()
                                });

                                commandResults.set(
                                    commandId,
                                    {
                                        id: commandId,
                                        status: "queued",
                                        command: "SET_USER_INFO",
                                        deviceId:
                                            command.targetDeviceId,
                                        enqueuedAt: mysqlDate()
                                    }
                                );

                                sendJson(
                                    res,
                                    202,
                                    {
                                        status: "queued",
                                        command_id: commandId,
                                        queue_length:
                                            commandQueue.length
                                    }
                                );
                            } catch (error) {
                                sendJson(
                                    res,
                                    400,
                                    { error: error.message }
                                );
                            }

                            return;
                        }

                        if (
                            req.method === "GET" &&
                            pathname.startsWith(commandStatusPrefix)
                        ) {
                            if (!isApiAuthorized(req)) {
                                sendJson(
                                    res,
                                    401,
                                    { error: "unauthorized" }
                                );

                                return;
                            }

                            const commandId =
                                pathname.slice(
                                    commandStatusPrefix.length
                                );
                            const result =
                                commandResults.get(
                                    commandId
                                ) || null;

                            if (!result) {
                                sendJson(
                                    res,
                                    404,
                                    { error: "command tidak ditemukan" }
                                );

                                return;
                            }

                            sendJson(res, 200, result);
                            return;
                        }

                        if (requestCode === "receive_cmd") {
                            const command =
                                dequeueCommand(deviceId);

                            if (command) {
                                sendDeviceAck(
                                    res,
                                    command.id,
                                    {
                                        cmdCode: command.cmd_code,
                                        body: formatCommandBody(
                                            command.body,
                                            command.binaryBlobs
                                        )
                                    }
                                );
                            } else {
                                sendDeviceAck(
                                    res,
                                    transaction
                                );
                            }

                            return;
                        }

                        if (requestCode === "send_cmd_result") {
                            const returnCode =
                                safeString(headers["cmd_return_code"]);
                            const resultSummary =
                                summarizeProtocolResult(buffer);
                            const successful =
                                !returnCode ||
                                returnCode === "0" ||
                                returnCode.toUpperCase() === "OK";
                            const result = {
                                id: transaction,
                                status: successful ? "completed" : "failed",
                                deviceId,
                                returnCode,
                                block:
                                    headers["blk_no"] || null,
                                response: resultSummary.data,
                                binary: resultSummary.binary,
                                completedAt: receivedAt
                            };

                            if (transaction) {
                                const previous =
                                    commandResults.get(
                                        transaction
                                    ) || {};

                                commandResults.set(
                                    transaction,
                                    {
                                        ...previous,
                                        ...result
                                    }
                                );
                            }

                            console.log(
                                `${receivedAt} | send_cmd_result | device=${deviceId || "-"} | trans=${transaction || "-"} | code=${result.returnCode || "-"}`
                            );

                            sendDeviceAck(res, transaction);
                            return;
                        }

                        const data = parsedData;

                        if (!data) {
                            console.log(
                                `${receivedAt} | NON_JSON | device=${deviceId || "-"}`
                            );

                            sendRequestAck(
                                res,
                                requestCode,
                                transaction
                            );

                            return;
                        }

                        /**
                         * ============================
                         * CLASSIFICATION
                         * ============================
                         */

                        const eventType =
                            classifyRequest(
                                requestCode
                            );

                        /**
                         * ============================
                         * EXTRACT DATA
                         * ============================
                         */

                        const userId =
                            safeString(
                                extractUserId(
                                    data
                                )
                            );

                        const name =
                            safeString(
                                extractName(
                                    data
                                )
                            );

                        const rawDeviceTime =
                            extractTime(
                                data
                            );

                        const resolvedDeviceTime =
                            resolveDeviceTime(
                                rawDeviceTime,
                                receivedAt
                            );

                        const cardNumber =
                            safeString(
                                extractCard(
                                    data
                                )
                            );

                        const qr =
                            safeString(
                                extractQR(
                                    data
                                )
                            );

                        const hasQR =
                            Boolean(qr);

                        const hasPhoto =
                            Boolean(
                                data.logPhoto ||
                                data.photo
                            );

                        /**
                         * ============================
                         * AUTH METHOD
                         * ============================
                         */

                        const auth =
                            detectAuthMethod(
                                data
                            );

                        /**
                         * ============================
                         * SANITIZE RAW DATA
                         * ============================
                         */

                        const sanitizedData =
                            sanitizeData(
                                data
                            );

                        /**
                         * ============================
                         * NORMALIZED EVENT
                         * ============================
                         */

                        const event = {

                            receivedAt,

                            ip,

                            deviceId,

                            deviceModel,

                            requestCode,

                            transaction,

                            eventType,

                            userId,

                            name,

                            authMethod:
                                auth.method,

                            authMethodRaw:
                                auth.rawValue,

                            deviceTime:
                                resolvedDeviceTime.value,

                            rawDeviceTime:
                                safeString(rawDeviceTime),

                            deviceTimeSource:
                                resolvedDeviceTime.source,

                            ioMode:
                                data.ioMode ??
                                null,

                            doorMode:
                                data.doorMode ??
                                null,

                            cardNumber,

                            hasQR,

                            hasPhoto,

                            rawData:
                                sanitizedData
                        };

                        if (!event.name && event.userId) {
                            event.name = await findEmployeeName(
                                event.deviceId,
                                event.userId
                            );
                        }

                        if (
                            event.eventType === "ENROLLMENT" &&
                            event.userId &&
                            event.name
                        ) {
                            await upsertEmployee({
                                deviceId: event.deviceId,
                                userId: event.userId,
                                employeeName: event.name,
                                source: "DEVICE"
                            });
                        }

                        event.eventType = classifyInboundEvent(event);

                        /**
                         * ============================
                         * PRINT
                         * ============================
                         */

                        printEvent(
                            event
                        );

                        /**
                         * ====================================
                         * DATABASE
                         * ====================================
                         *
                         * Hanya ATT_LOG yang masuk ke attendance_logs.
                         * Pesan/status alat dan enrollment masuk ke
                         * device_messages.
                         */

                        if (event.eventType === "ATT_LOG") {

                            if (!hasAttendanceIdentity(event)) {
                                console.log(
                                    "   ↳ DB SKIP (NO_ATTENDANCE_IDENTITY)"
                                );

                                sendRequestAck(
                                    res,
                                    requestCode,
                                    transaction
                                );

                                return;
                            }

                            if (isDuplicateAttendance(event)) {
                                console.log(
                                    "   ↳ DB SKIP (DUPLICATE)"
                                );

                                sendRequestAck(
                                    res,
                                    requestCode,
                                    transaction
                                );

                                return;
                            }

                            try {

                                const insertId =
                                    await saveAttendance(
                                        event
                                    );

                                console.log(
                                    `   ↳ DB SAVED id=${insertId}`
                                );

                            } catch (dbError) {

                                console.error(
                                    "   ↳ DB ERROR:",
                                    dbError.message
                                );
                            }

                        } else {
                            try {
                                const insertId =
                                    await saveDeviceMessage(event);

                                console.log(
                                    `   DEVICE MESSAGE SAVED id=${insertId}`
                                );
                            } catch (dbError) {
                                console.error(
                                    "   DEVICE MESSAGE DB ERROR:",
                                    dbError.message
                                );
                            }

                        }

                        /**
                         * ============================
                         * RESPONSE
                         * ============================
                         */

                        sendRequestAck(
                            res,
                            requestCode,
                            transaction
                        );

                    } catch (error) {

                        console.error(
                            "PROCESS ERROR:",
                            error
                        );

                        sendRequestAck(
                            res,
                            requestCode,
                            transaction
                        );
                    }
                }
            );
        }
    );

/**
 * ============================================================
 * TEST DATABASE
 * ============================================================
 */

async function testDatabase() {

    try {

        const connection =
            await db.getConnection();

        await connection.query(
            "SELECT 1"
        );

        await connection.query(`
            CREATE TABLE IF NOT EXISTS attendance_logs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                device_id VARCHAR(100) NULL,
                device_model VARCHAR(100) NULL,
                user_id VARCHAR(100) NULL,
                employee_name VARCHAR(255) NULL,
                auth_method VARCHAR(50) NOT NULL DEFAULT 'UNKNOWN',
                device_time DATETIME NULL,
                received_at DATETIME NOT NULL,
                io_mode INT NULL,
                door_mode VARCHAR(100) NULL,
                request_code VARCHAR(100) NULL,
                transaction_id VARCHAR(100) NULL,
                card_number VARCHAR(100) NULL,
                has_qr TINYINT(1) NOT NULL DEFAULT 0,
                ip_address VARCHAR(45) NULL,
                raw_data LONGTEXT NULL,
                created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_attendance_device_user (device_id, user_id),
                KEY idx_attendance_device_time (device_time),
                KEY idx_attendance_received (received_at),
                KEY idx_attendance_request (request_code)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                device_id VARCHAR(100) NOT NULL DEFAULT '',
                user_id VARCHAR(100) NOT NULL,
                employee_name VARCHAR(255) NOT NULL,
                privilege INT NOT NULL DEFAULT 0,
                source VARCHAR(30) NOT NULL DEFAULT 'DEVICE',
                created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_employees_device_user (device_id, user_id),
                KEY idx_employees_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS device_messages (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                device_id VARCHAR(100) NULL,
                device_model VARCHAR(100) NULL,
                message_type VARCHAR(50) NOT NULL,
                request_code VARCHAR(100) NULL,
                transaction_id VARCHAR(100) NULL,
                user_id VARCHAR(100) NULL,
                employee_name VARCHAR(255) NULL,
                device_time DATETIME NULL,
                received_at DATETIME NOT NULL,
                io_mode INT NULL,
                door_mode VARCHAR(100) NULL,
                ip_address VARCHAR(45) NULL,
                raw_data LONGTEXT NULL,
                created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_device_messages_device (device_id),
                KEY idx_device_messages_type (message_type),
                KEY idx_device_messages_request (request_code),
                KEY idx_device_messages_received (received_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        connection.release();

        console.log(
            "Database  : CONNECTED"
        );

        return true;

    } catch (error) {

        console.error(
            "Database  : FAILED"
        );

        console.error(
            error.message
        );

        return false;
    }
}

/**
 * ============================================================
 * START
 * ============================================================
 */

async function start() {

    console.log("");
    console.log(
        "================================================"
    );

    console.log(
        "          R6 ATTENDANCE LISTENER"
    );

    console.log(
        "================================================"
    );

    await testDatabase();

    server.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                `Listening : http://0.0.0.0:${PORT}`
            );

            console.log(
                "Photo     : DISABLED"
            );

            console.log(
                "Database  : fingerspot.attendance_logs"
            );

            console.log(
                "================================================"
            );

            console.log("");
        }
    );
}

start();

/**
 * ============================================================
 * SERVER ERROR
 * ============================================================
 */

server.on(
    "error",
    error => {

        console.error(
            "SERVER ERROR:",
            error.message
        );

        if (
            error.code ===
            "EADDRINUSE"
        ) {
            console.error(
                `Port ${PORT} sedang digunakan.`
            );
        }
    }
);

/**
 * ============================================================
 * SHUTDOWN
 * ============================================================
 */

async function shutdown(signal) {

    console.log("");
    console.log(
        `${signal} received...`
    );

    server.close(
        async () => {

            try {
                await db.end();
            } catch {
                //
            }

            console.log(
                "Server stopped."
            );

            process.exit(0);
        }
    );
}

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);
