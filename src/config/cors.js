// KONFIGURASI CORS (Stage 2.3a)
//
// Daftar origin yang boleh memanggil API dari browser dibaca dari CORS_ORIGINS (dipisah koma),
// misalnya: CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
//
// Aturan:
//  - Jika CORS_ORIGINS kosong/tidak ada, TIDAK ada origin browser yang diizinkan (aman secara default).
//  - Tanda "*" dan entri yang bukan origin valid (http/https) diabaikan dan diberi peringatan.
//  - Permintaan tanpa header Origin (bot Telegram, curl, server-ke-server) tidak dipengaruhi CORS.
//
// CATATAN: CORS bukan pengganti autentikasi. Selama autentikasi belum ada, API hanya boleh
// dijalankan di komputer lokal (lihat BIND_HOST di app.js).

export function parseAllowedOrigins(value, warn = console.warn) {
    if (typeof value !== "string" || value.trim() === "") {
        return [];
    }

    const origins = [];

    for (const raw of value.split(",")) {
        const entry = raw.trim();

        if (entry === "") {
            continue;
        }

        let origin;

        try {
            const url = new URL(entry);

            if (
                (url.protocol !== "http:" && url.protocol !== "https:") ||
                url.username !== "" ||
                url.password !== "" ||
                url.pathname.replace(/\/+$/, "") !== "" ||
                url.search !== "" ||
                url.hash !== ""
            ) {
                throw new Error("not an origin");
            }

            origin = url.origin.toLowerCase();
        } catch {
            warn(`CORS_ORIGINS: entri "${entry}" diabaikan (harus berbentuk http(s)://host[:port], tanpa path)`);
            continue;
        }

        if (!origins.includes(origin)) {
            origins.push(origin);
        }
    }

    return origins;
}

export function buildCorsOptions(env = process.env, warn = console.warn) {
    const allowed = parseAllowedOrigins(env.CORS_ORIGINS, warn);

    return {
        // Tanpa Origin (bukan browser) -> lolos. Origin tidak terdaftar -> tidak diberi header CORS.
        origin(origin, callback) {
            if (!origin) {
                return callback(null, false);
            }

            return callback(null, allowed.includes(origin.toLowerCase()));
        },
        methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
        maxAge: 600,
    };
}
