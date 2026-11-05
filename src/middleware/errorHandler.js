import { Prisma } from "@prisma/client";
import AppError from "../utils/AppError.js";

// Dipasang SETELAH semua route: menangani URL yang tidak ada.
export function notFoundHandler(req, res, next) {
    next(new AppError(404, "ROUTE_NOT_FOUND", `Route ${req.method} ${req.path} not found`));
}

// Dipasang paling akhir: semua error dari route/middleware berakhir di sini,
// sehingga format respon error selalu sama dan detail internal tidak bocor ke pengguna.
// Express mengenali error handler dari jumlah parameternya (harus 4).
export function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    // 1. Error yang kita lempar sendiri (aman ditampilkan)
    if (err instanceof AppError) {
        return sendError(res, err.statusCode, err.code, err.message, err.details);
    }

    // 2. Body request bukan JSON yang valid, atau terlalu besar (dari express.json())
    if (err.type === "entity.parse.failed") {
        return sendError(res, 400, "INVALID_JSON", "Request body is not valid JSON");
    }

    if (err.type === "entity.too.large") {
        return sendError(res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }

    // 3. Error database yang sudah dikenal. Pesan aslinya TIDAK ditampilkan ke pengguna.
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === "P2002") {
            return sendError(res, 409, "CONFLICT", "Resource already exists");
        }

        if (err.code === "P2025") {
            return sendError(res, 404, "NOT_FOUND", "Resource not found");
        }

        if (err.code === "P2028") {
            return sendError(res, 503, "DATABASE_BUSY", "Database is busy, please try again");
        }
    }

    // 4. Selain itu dianggap bug: catat lengkap di server, tampilkan pesan umum ke pengguna.
    console.error("Unhandled error:", err);
    return sendError(res, 500, "INTERNAL_ERROR", "Internal server error");
}

function sendError(res, statusCode, code, message, details) {
    const body = { success: false, code, message };

    if (details !== undefined) {
        body.details = details;
    }

    return res.status(statusCode).json(body);
}
