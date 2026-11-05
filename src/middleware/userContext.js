import prisma from "../config/database.js";
import AppError from "../utils/AppError.js";

// Menentukan "siapa pengguna yang sedang memakai API" dan menyimpannya di req.user.
//
// SEMENTARA: pengguna diambil dari DEFAULT_USER_ID di file .env (mode satu pengguna).
// NANTI: middleware ini diganti dengan identitas Telegram (ChannelIdentity) atau login dashboard.
//
// ATURAN PENTING untuk semua service: ambil userId HANYA dari req.user.id.
// Jangan pernah mengambil userId dari body, query, atau params request.
export default async function userContext(req, res, next) {
    const rawUserId = (process.env.DEFAULT_USER_ID ?? "").trim();

    if (!/^[1-9]\d{0,18}$/.test(rawUserId)) {
        console.error("DEFAULT_USER_ID is missing or invalid in .env");
        throw new AppError(
            500,
            "USER_CONTEXT_NOT_CONFIGURED",
            "Server user configuration is invalid"
        );
    }

    const user = await prisma.user.findUnique({
        where: { id: BigInt(rawUserId) },
        select: { id: true, name: true },
    });

    if (!user) {
        console.error(`DEFAULT_USER_ID=${rawUserId} does not exist in the users table`);
        throw new AppError(401, "USER_NOT_FOUND", "User was not found");
    }

    req.user = user;
    next();
}
