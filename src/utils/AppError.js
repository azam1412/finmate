// Error yang "disengaja" oleh aplikasi (validasi gagal, data tidak ditemukan, dll).
// Pesannya aman ditampilkan ke pengguna. Error lain dianggap bug dan disembunyikan.
export default class AppError extends Error {
    /**
     * @param {number} statusCode HTTP status code, misalnya 400, 404, 422
     * @param {string} code       kode singkat yang stabil, misalnya "VALIDATION_ERROR"
     * @param {string} message    pesan yang aman dibaca pengguna
     * @param {object} [details]  informasi tambahan (opsional), misalnya field yang salah
     */
    constructor(statusCode, code, message, details = undefined) {
        super(message);
        this.name = "AppError";
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}
