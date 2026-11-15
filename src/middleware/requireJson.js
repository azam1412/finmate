import AppError from "../utils/AppError.js";

// JSON GUARD (Stage 2.3a)
//
// Request yang mengubah data (POST/PUT/PATCH/DELETE) wajib bertipe application/json.
// Alasannya: form HTML di situs lain bisa mengirim POST bertipe application/x-www-form-urlencoded,
// multipart/form-data, atau text/plain TANPA preflight CORS. Dengan menolak tipe selain JSON,
// pengiriman seperti itu ditolak sebelum menyentuh logika bisnis apa pun.
//
// Ini BUKAN pengganti autentikasi.

const METHODS_REQUIRING_JSON = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export default function requireJson(req, res, next) {
    if (!METHODS_REQUIRING_JSON.has(req.method)) {
        return next();
    }

    const mediaType = String(req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();

    if (mediaType !== "application/json") {
        return next(
            new AppError(
                415,
                "UNSUPPORTED_MEDIA_TYPE",
                'Content-Type must be "application/json"'
            )
        );
    }

    return next();
}
