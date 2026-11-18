import AppError from "../utils/AppError.js";

// KONTRAK BODY KOSONG (Stage 2.3b) untuk endpoint aksi tanpa data: confirm dan cancel.
//
// Yang diterima: tanpa isi, atau objek kosong {}. Keduanya diperlakukan sama.
// Yang ditolak 400 VALIDATION_ERROR: array dan objek berisi field APA PUN (termasuk userId, status).
// Body yang bukan objek/array (null, string, angka) sudah ditolak lebih awal oleh express.json
// sebagai 400 INVALID_JSON. Content-Type application/json tetap diwajibkan oleh requireJson.
//
// Ini hanya kontrak HTTP, bukan logika bisnis: operasi tidak pernah membaca isi body.

export default function requireEmptyBody(req, res, next) {
    const body = req.body;

    if (body === undefined) {
        return next();
    }

    const isPlainObject = body !== null && typeof body === "object" && !Array.isArray(body);

    if (!isPlainObject) {
        return next(new AppError(400, "VALIDATION_ERROR", "Request body must be empty or {}", { field: "body" }));
    }

    const [firstKey] = Object.keys(body);

    if (firstKey !== undefined) {
        return next(
            new AppError(400, "VALIDATION_ERROR", `Request body must be empty or {} (unexpected field: ${firstKey})`, {
                field: firstKey,
            })
        );
    }

    return next();
}
