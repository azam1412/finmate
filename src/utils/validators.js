import { Prisma } from "@prisma/client";
import AppError from "./AppError.js";

const MAX_BIGINT = 9223372036854775807n;

// Nominal: angka positif, maksimal 13 digit bulat dan 2 desimal (sesuai DECIMAL(15,2)).
const MONEY_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;

function validationError(message, fieldName) {
    return new AppError(400, "VALIDATION_ERROR", message, { field: fieldName });
}

// Mengubah input (string atau angka) menjadi BigInt untuk id database.
export function parseId(value, fieldName = "id") {
    let text;

    if (typeof value === "string") {
        text = value.trim();
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
        text = String(value);
    } else {
        throw validationError(`${fieldName} must be a positive integer`, fieldName);
    }

    if (!/^[1-9]\d{0,18}$/.test(text)) {
        throw validationError(`${fieldName} must be a positive integer`, fieldName);
    }

    const id = BigInt(text);

    if (id > MAX_BIGINT) {
        throw validationError(`${fieldName} is too large`, fieldName);
    }

    return id;
}

// Mengubah input nominal menjadi Prisma.Decimal. Tidak pernah memakai float untuk perhitungan.
// Disarankan klien mengirim nominal sebagai string, misalnya "25000" atau "25000.50".
// Angka seperti 0.1 + 0.2 (= 0.30000000000000004) sengaja ditolak karena desimalnya > 2.
export function parseMoney(value, fieldName = "amount") {
    let text;

    if (typeof value === "string") {
        text = value.trim();
    } else if (typeof value === "number" && Number.isFinite(value)) {
        text = String(value);
    } else {
        throw validationError(`${fieldName} must be a valid amount`, fieldName);
    }

    if (!MONEY_PATTERN.test(text)) {
        throw validationError(
            `${fieldName} must be a number with at most 2 decimal places`,
            fieldName
        );
    }

    const amount = new Prisma.Decimal(text);

    if (!amount.gt(0)) {
        throw validationError(`${fieldName} must be greater than 0`, fieldName);
    }

    return amount;
}

// ---------------------------------------------------------------------------
// Validator tambahan untuk input transaksi (Stage 2.2b)
// ---------------------------------------------------------------------------

const SOURCES = ["TELEGRAM", "WEB", "WHATSAPP"];
const MAX_DESCRIPTION_LENGTH = 500;

// Kunci idempotency dari klien: 1-100 karakter (huruf, angka, titik, garis bawah, titik dua, strip).
// Batas 100 menjaga kunci tersimpan "{userId}:{key}" tetap muat di kolom VARCHAR(150).
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

// Format ISO 8601 lengkap dengan zona waktu, misalnya 2026-11-09T10:30:00+07:00 atau ...Z.
// Tanggal tanpa zona waktu sengaja ditolak agar tidak ambigu (WIB atau UTC?).
const DATE_TIME_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

// Menolak field yang tidak dikenal. Ini mencegah klien mengirim field seperti
// userId atau status dan mengira field itu dipakai (field itu tidak pernah dipakai).
export function assertOnlyFields(input, allowedFields) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw validationError("Request body must be an object", "body");
    }

    for (const key of Object.keys(input)) {
        if (!allowedFields.includes(key)) {
            throw validationError(`Unknown field: ${key}`, key);
        }
    }
}

export function parseSource(value, fieldName = "source") {
    if (typeof value !== "string" || !SOURCES.includes(value)) {
        throw validationError(`${fieldName} must be one of: ${SOURCES.join(", ")}`, fieldName);
    }

    return value;
}

// Mengembalikan string yang sudah di-trim, atau null jika kosong.
export function parseDescription(value, fieldName = "description") {
    if (value === null) {
        return null;
    }

    if (typeof value !== "string") {
        throw validationError(`${fieldName} must be a string`, fieldName);
    }

    const text = value.trim();

    if (text.length > MAX_DESCRIPTION_LENGTH) {
        throw validationError(
            `${fieldName} must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
            fieldName
        );
    }

    return text === "" ? null : text;
}

// JavaScript diam-diam menggeser tanggal yang mustahil (31 Februari menjadi 3 Maret),
// jadi tanggalnya diperiksa ulang secara eksplisit. Rentang tahun dibatasi 2000-2099.
export function parseTransactionDate(value, fieldName = "transactionDate") {
    const text = typeof value === "string" ? value.trim() : "";
    const match = DATE_TIME_PATTERN.exec(text);

    if (!match) {
        throw validationError(
            `${fieldName} must be an ISO 8601 date-time with timezone, e.g. 2026-11-09T10:30:00+07:00`,
            fieldName
        );
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendarCheck = new Date(Date.UTC(year, month - 1, day));

    if (
        year < 2000 ||
        year > 2099 ||
        calendarCheck.getUTCMonth() !== month - 1 ||
        calendarCheck.getUTCDate() !== day
    ) {
        throw validationError(`${fieldName} is not a valid date`, fieldName);
    }

    const date = new Date(text);

    if (Number.isNaN(date.getTime())) {
        throw validationError(`${fieldName} is not a valid date`, fieldName);
    }

    return date;
}

export function parseIdempotencyKey(value, fieldName = "idempotencyKey") {
    if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
        throw validationError(
            `${fieldName} must be 1-100 characters: letters, digits, dot, underscore, colon, or hyphen`,
            fieldName
        );
    }

    return value;
}
