import AppError from "./AppError.js";
import { assertOnlyFields, parseId, parseSource, parseTransactionDate } from "./validators.js";

// VALIDASI QUERY STRING (Stage 2.3c)
//
// Express mengurai query string dengan aturan longgar: nilai ganda menjadi array
// (?type=A&type=B), "?type=" menjadi string kosong, dan "?type[]=A" menjadi key literal "type[]".
// Semua bentuk itu ditolak di sini dengan 400 VALIDATION_ERROR, begitu juga parameter yang tidak
// dikenal (termasuk userId), sesuai kebijakan "tolak field tak dikenal" pada body di 2.3a/2.3b.

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_PAGE = 10000;
export const MAX_LIMIT = 100;

const LIST_QUERY_FIELDS = [
    "type",
    "status",
    "source",
    "walletId",
    "categoryId",
    "from",
    "to",
    "page",
    "limit",
];

const TYPES = ["INCOME", "EXPENSE", "TRANSFER"];
const STATUSES = ["PENDING", "CONFIRMED", "CANCELLED"];

const validationError = (message, field) =>
    new AppError(400, "VALIDATION_ERROR", message, { field });

// Nilai query yang diberikan harus berupa SATU string tidak kosong.
function readSingle(query, name) {
    const value = query[name];

    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw validationError(`${name} must be given once, as a single value`, name);
    }

    if (value.trim() === "") {
        throw validationError(`${name} must not be empty`, name);
    }

    return value;
}

function parseEnum(value, allowed, name) {
    if (!allowed.includes(value)) {
        throw validationError(`${name} must be one of: ${allowed.join(", ")}`, name);
    }

    return value;
}

// Hanya digit biasa (tanpa spasi, tanda, atau eksponen), nilai 1..max.
function parseBoundedInteger(value, name, max) {
    if (!/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > max) {
        throw validationError(`${name} must be an integer between 1 and ${max}`, name);
    }

    return Number(value);
}

// Tanda "+" pada zona waktu (+07:00) di URL terbaca sebagai spasi bila tidak di-encode.
function parseBoundary(value, name) {
    try {
        return parseTransactionDate(value, name);
    } catch (err) {
        if (err instanceof AppError) {
            throw validationError(
                `${err.message} (in a URL, write "+" as %2B, or use Z for UTC)`,
                name
            );
        }

        throw err;
    }
}

/**
 * Memvalidasi query daftar transaksi.
 * @returns { filters: { type?, status?, source?, walletId?, categoryId?, from?, to? }, page, limit }
 */
export function parseTransactionListQuery(query) {
    assertOnlyFields(query, LIST_QUERY_FIELDS);

    const filters = {};

    const type = readSingle(query, "type");
    if (type !== undefined) filters.type = parseEnum(type, TYPES, "type");

    const status = readSingle(query, "status");
    if (status !== undefined) filters.status = parseEnum(status, STATUSES, "status");

    const source = readSingle(query, "source");
    if (source !== undefined) filters.source = parseSource(source, "source");

    const walletId = readSingle(query, "walletId");
    if (walletId !== undefined) filters.walletId = parseId(walletId, "walletId");

    const categoryId = readSingle(query, "categoryId");
    if (categoryId !== undefined) filters.categoryId = parseId(categoryId, "categoryId");

    const from = readSingle(query, "from");
    if (from !== undefined) filters.from = parseBoundary(from, "from");

    const to = readSingle(query, "to");
    if (to !== undefined) filters.to = parseBoundary(to, "to");

    if (filters.from && filters.to && filters.from.getTime() > filters.to.getTime()) {
        throw validationError("from must not be later than to", "from");
    }

    const page = readSingle(query, "page");
    const limit = readSingle(query, "limit");

    return {
        filters,
        page: page === undefined ? DEFAULT_PAGE : parseBoundedInteger(page, "page", MAX_PAGE),
        limit: limit === undefined ? DEFAULT_LIMIT : parseBoundedInteger(limit, "limit", MAX_LIMIT),
    };
}

// Detail transaksi tidak menerima query string apa pun.
export function assertNoQuery(query) {
    assertOnlyFields(query, []);
}
