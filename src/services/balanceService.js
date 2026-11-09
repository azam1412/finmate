import { Prisma } from "@prisma/client";
import AppError from "../utils/AppError.js";

// PERHITUNGAN SALDO DOMPET
//
// Saldo TIDAK disimpan di kolom mana pun. Saldo selalu dihitung ulang dari data:
//
//   saldo = initialBalance
//         + total INCOME          (CONFIRMED, dompet ini sebagai walletId)
//         - total EXPENSE         (CONFIRMED, dompet ini sebagai walletId)
//         - total TRANSFER keluar (CONFIRMED, dompet ini sebagai walletId)
//         + total TRANSFER masuk  (CONFIRMED, dompet ini sebagai destinationWalletId)
//
// Hanya transaksi berstatus CONFIRMED yang dihitung. PENDING dan CANCELLED diabaikan,
// sehingga membatalkan transaksi otomatis "mengembalikan" saldo tanpa ada yang perlu dikoreksi.
//
// Fungsi di sini membaca data saja. Untuk keputusan yang bergantung pada saldo
// (misalnya "saldo cukup?"), panggil SETELAH lockWallets() di dalam runInTransaction()
// (lihat utils/dbTransaction.js), dengan `tx` sebagai parameter pertama.

const ZERO = new Prisma.Decimal(0);

function sumOf(row) {
    return row?._sum?.amount ? new Prisma.Decimal(row._sum.amount) : ZERO;
}

/**
 * Menghitung saldo dompet milik user.
 *
 * @param db        prisma atau `tx` dari runInTransaction
 * @param userId    id pemilik (BigInt). Dompet milik user lain dianggap tidak ditemukan.
 * @param walletIds (opsional) daftar id dompet (BigInt/string/number, sudah divalidasi lewat parseId).
 *                  Jika dihilangkan, semua dompet milik user dihitung.
 * @returns Map<BigInt id, {
 *   walletId, name, isActive, initialBalance,
 *   totalIncome, totalExpense, transferIn, transferOut, balance   // semuanya Prisma.Decimal
 * }>, terurut menurut id dompet
 * @throws AppError 404 WALLET_NOT_FOUND jika ada id yang tidak ada atau bukan milik user
 */
export async function getWalletBalances(db, userId, walletIds = undefined) {
    const ids =
        walletIds === undefined
            ? undefined
            : [...new Set(walletIds.map((id) => BigInt(id)))];

    if (ids && ids.length === 0) {
        return new Map();
    }

    const wallets = await db.wallet.findMany({
        where: { userId, ...(ids ? { id: { in: ids } } : {}) },
        select: { id: true, name: true, isActive: true, initialBalance: true },
        orderBy: { id: "asc" },
    });

    // Dompet yang tidak ada dan dompet milik user lain memberi respon yang sama.
    if (ids && wallets.length !== ids.length) {
        throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found");
    }

    if (wallets.length === 0) {
        return new Map();
    }

    const foundIds = wallets.map((wallet) => wallet.id);

    // Dua query agregat (bukan mengambil semua baris transaksi), dijalankan berurutan
    // karena `db` bisa berupa interactive transaction yang berbagi satu koneksi.
    const asSource = await db.transaction.groupBy({
        by: ["walletId", "type"],
        where: { userId, status: "CONFIRMED", walletId: { in: foundIds } },
        _sum: { amount: true },
    });

    const asDestination = await db.transaction.groupBy({
        by: ["destinationWalletId"],
        where: {
            userId,
            status: "CONFIRMED",
            type: "TRANSFER",
            destinationWalletId: { in: foundIds },
        },
        _sum: { amount: true },
    });

    const result = new Map();

    for (const wallet of wallets) {
        const sumFor = (type) =>
            sumOf(asSource.find((row) => row.walletId === wallet.id && row.type === type));

        const totalIncome = sumFor("INCOME");
        const totalExpense = sumFor("EXPENSE");
        const transferOut = sumFor("TRANSFER");
        const transferIn = sumOf(
            asDestination.find((row) => row.destinationWalletId === wallet.id)
        );

        const initialBalance = new Prisma.Decimal(wallet.initialBalance);
        const balance = initialBalance
            .plus(totalIncome)
            .minus(totalExpense)
            .minus(transferOut)
            .plus(transferIn);

        result.set(wallet.id, {
            walletId: wallet.id,
            name: wallet.name,
            isActive: wallet.isActive,
            initialBalance,
            totalIncome,
            totalExpense,
            transferIn,
            transferOut,
            balance,
        });
    }

    return result;
}

/**
 * Saldo satu dompet milik user (lihat getWalletBalances untuk bentuk hasilnya).
 * @throws AppError 404 WALLET_NOT_FOUND
 */
export async function getWalletBalance(db, userId, walletId) {
    const balances = await getWalletBalances(db, userId, [walletId]);
    return balances.get(BigInt(walletId));
}
