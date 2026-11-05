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
