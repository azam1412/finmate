import AppError from "../utils/AppError.js";
import { parseId } from "../utils/validators.js";
import { runInTransaction, lockWallets } from "../utils/dbTransaction.js";
import { getWalletBalances } from "./balanceService.js";
import { presentTransaction } from "./transactionService.js";

// PEMBATALAN TRANSAKSI (Stage 2.2e): PENDING atau CONFIRMED -> CANCELLED
//
// Saldo tidak disimpan, jadi "mengembalikan dampak" berarti mengubah status menjadi CANCELLED;
// getWalletBalances() hanya menghitung transaksi CONFIRMED sehingga dampaknya otomatis hilang.
//
// Aturan:
//  - PENDING: boleh dibatalkan, tanpa pengecekan saldo (PENDING memang tidak dihitung).
//  - CONFIRMED: boleh dibatalkan hanya bila pembalikan tidak membuat saldo dompet mana pun negatif.
//      INCOME   -> saldo dompet berkurang sebesar nominal, harus tetap >= 0
//      EXPENSE  -> saldo dompet bertambah, tidak perlu dicek
//      TRANSFER -> sumber bertambah, TUJUAN berkurang sebesar nominal (harus tetap >= 0);
//                  kedua dompet berubah sekaligus oleh satu UPDATE, jadi atomik
//  - CANCELLED bersifat final: pembatalan ulang ditolak 409 tanpa mengubah data apa pun.
//  - Dompet yang terlibat harus milik user dan aktif, sama seperti pada konfirmasi
//    (confirmationService.js). Akibatnya transaksi pada dompet nonaktif tidak bisa dibatalkan
//    sampai dompetnya diaktifkan kembali.
//
// Urutan penguncian SAMA dengan pembuatan dan konfirmasi: dompet (id terkecil dulu), baru baris
// transaksi. Pembacaan awal tanpa kunci tidak menahan kunci apa pun (READ COMMITTED), sehingga
// pembatalan, konfirmasi, dan pembuatan transaksi tidak bisa saling menunggu dalam lingkaran.

/**
 * Membatalkan satu transaksi milik user.
 *
 * @param userId        BigInt, dari req.user.id
 * @param transactionId id transaksi (BigInt/string/number)
 * @returns { transaction, balances }  balances = saldo terbaru tiap dompet yang terlibat,
 *          terurut menurut id: [{ walletId, balance }]  (balance = Prisma.Decimal)
 * @throws AppError 400 VALIDATION_ERROR | 404 TRANSACTION_NOT_FOUND | 404 WALLET_NOT_FOUND |
 *         409 TRANSACTION_ALREADY_CANCELLED | 422 WALLET_INACTIVE | 422 CANCELLATION_NEGATIVE_BALANCE
 */
export async function cancelTransaction(userIdInput, transactionIdInput) {
    const userId = BigInt(userIdInput);
    const transactionId = parseId(transactionIdInput, "transactionId");

    return runInTransaction(async (tx) => {
        // 1. Baca tanpa kunci, hanya untuk mengetahui dompet yang terlibat. Dompet dan nominal
        //    tidak pernah berubah setelah transaksi dibuat.
        const initial = await tx.transaction.findFirst({
            where: { id: transactionId, userId },
            select: { walletId: true, destinationWalletId: true },
        });

        // Transaksi yang tidak ada dan transaksi milik user lain memberi respon yang sama.
        if (!initial) {
            throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found");
        }

        const walletIds = initial.destinationWalletId
            ? [initial.walletId, initial.destinationWalletId]
            : [initial.walletId];

        // 2. Kunci SEMUA dompet yang terlibat (urut id). Konfirmasi, pembatalan, dan transaksi
        //    lain pada dompet yang sama antre di sini. Juga memvalidasi kepemilikan dan status aktif.
        await lockWallets(tx, userId, walletIds);

        // 3. Baca ulang SETELAH kunci didapat: selama menunggu, transaksi ini mungkin sudah
        //    dikonfirmasi atau dibatalkan oleh permintaan lain.
        const current = await tx.transaction.findFirst({ where: { id: transactionId, userId } });

        if (!current) {
            throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found");
        }

        if (
            current.walletId !== initial.walletId ||
            (current.destinationWalletId ?? null) !== (initial.destinationWalletId ?? null)
        ) {
            throw new AppError(409, "TRANSACTION_CHANGED", "Transaction changed, please retry");
        }

        if (current.status === "CANCELLED") {
            throw new AppError(
                409,
                "TRANSACTION_ALREADY_CANCELLED",
                "A cancelled transaction cannot be cancelled again",
                { status: current.status }
            );
        }

        // 4. Hanya transaksi CONFIRMED yang punya dampak pada saldo. Dompet yang saldonya BERKURANG
        //    akibat pembatalan: dompet pemasukan (INCOME) atau dompet tujuan (TRANSFER).
        //    Pembatalan EXPENSE hanya menambah saldo, dan pembatalan PENDING tidak mengubah apa pun.
        //    Saldo dibaca SETELAH kunci didapat, jadi memakai nilai terbaru.
        const decreasedWalletId =
            current.status !== "CONFIRMED"
                ? null
                : current.type === "INCOME"
                  ? current.walletId
                  : current.type === "TRANSFER"
                    ? current.destinationWalletId
                    : null;

        if (decreasedWalletId !== null) {
            const before = await getWalletBalances(tx, userId, [decreasedWalletId]);
            const balance = before.get(decreasedWalletId).balance;
            const balanceAfter = balance.minus(current.amount);

            if (balanceAfter.lt(0)) {
                throw new AppError(
                    422,
                    "CANCELLATION_NEGATIVE_BALANCE",
                    "Cancelling this transaction would make a wallet balance negative",
                    {
                        walletId: String(decreasedWalletId),
                        balance: balance.toFixed(2),
                        balanceAfterCancellation: balanceAfter.toFixed(2),
                    }
                );
            }
        }

        // 5. Compare-and-set: hanya mengubah baris yang statusnya masih seperti yang baru dibaca.
        const { count } = await tx.transaction.updateMany({
            where: { id: transactionId, userId, status: current.status },
            data: { status: "CANCELLED", cancelledAt: new Date() },
        });

        if (count !== 1) {
            throw new AppError(409, "TRANSACTION_CHANGED", "Transaction changed, please retry");
        }

        // 6. Hitung ulang dan pastikan dompet yang saldonya berkurang tidak menjadi minus (pengaman
        //    terhadap bug logika; bila terjadi, seluruh transaksi database dibatalkan).
        const after = await getWalletBalances(tx, userId, walletIds);

        if (decreasedWalletId !== null && after.get(decreasedWalletId).balance.lt(0)) {
            throw new Error(
                `Invariant violated: wallet ${decreasedWalletId} would have a negative balance after cancelling transaction ${current.id}`
            );
        }

        const cancelled = await tx.transaction.findUnique({ where: { id: transactionId } });

        return {
            transaction: presentTransaction(cancelled),
            balances: [...after.values()].map(({ walletId, balance }) => ({ walletId, balance })),
        };
    });
}
