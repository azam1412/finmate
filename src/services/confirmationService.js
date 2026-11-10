import AppError from "../utils/AppError.js";
import { parseId } from "../utils/validators.js";
import { runInTransaction, lockWallets } from "../utils/dbTransaction.js";
import { getWalletBalances } from "./balanceService.js";
import { presentTransaction } from "./transactionService.js";

// KONFIRMASI TRANSAKSI (Stage 2.2d): PENDING -> CONFIRMED
//
// Saldo tidak disimpan, jadi "menambah/mengurangi saldo" berarti mengubah status menjadi
// CONFIRMED; getWalletBalances() menghitung dampaknya. Transfer atomik secara alami karena satu
// UPDATE pada satu baris mengubah dampak ke dua dompet sekaligus.
//
// Urutan penguncian SELALU: dompet (id terkecil dulu), baru baris transaksi. Urutan yang sama
// dipakai saat pembuatan transaksi, sehingga tidak ada siklus tunggu (deadlock).
//
// Aturan:
//  - Hanya PENDING yang boleh dikonfirmasi. CONFIRMED atau CANCELLED ditolak 409.
//  - EXPENSE dan TRANSFER: saldo dompet sumber harus cukup (saldo >= nominal), bila tidak 422.
//  - INCOME tidak memerlukan pengecekan saldo.
//  - Dompet yang terlibat harus masih milik user dan aktif.

/**
 * Mengonfirmasi satu transaksi PENDING milik user.
 *
 * @param userId        BigInt, dari req.user.id
 * @param transactionId id transaksi (BigInt/string/number)
 * @returns { transaction, balances }  balances = saldo terbaru tiap dompet yang terlibat,
 *          terurut menurut id: [{ walletId, balance }]  (balance = Prisma.Decimal)
 * @throws AppError 400 VALIDATION_ERROR | 404 TRANSACTION_NOT_FOUND | 404 WALLET_NOT_FOUND |
 *         409 TRANSACTION_NOT_PENDING | 422 WALLET_INACTIVE | 422 INSUFFICIENT_BALANCE
 */
export async function confirmTransaction(userIdInput, transactionIdInput) {
    const userId = BigInt(userIdInput);
    const transactionId = parseId(transactionIdInput, "transactionId");

    return runInTransaction(async (tx) => {
        // 1. Baca tanpa kunci, hanya untuk mengetahui dompet yang terlibat. Dompet dan nominal
        //    tidak pernah berubah setelah transaksi dibuat (perubahan = batalkan lalu buat baru).
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

        // 2. Kunci dompet (urut id). Konfirmasi lain pada dompet yang sama antre di sini.
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

        if (current.status !== "PENDING") {
            throw new AppError(
                409,
                "TRANSACTION_NOT_PENDING",
                current.status === "CANCELLED"
                    ? "A cancelled transaction cannot be confirmed"
                    : `Only PENDING transactions can be confirmed (current status: ${current.status})`,
                { status: current.status }
            );
        }

        // 4. Saldo dompet sumber harus cukup untuk EXPENSE dan TRANSFER.
        if (current.type !== "INCOME") {
            const before = await getWalletBalances(tx, userId, [current.walletId]);
            const available = before.get(current.walletId).balance;

            if (available.lt(current.amount)) {
                throw new AppError(422, "INSUFFICIENT_BALANCE", "Insufficient balance", {
                    walletId: String(current.walletId),
                    available: available.toFixed(2),
                    required: current.amount.toFixed(2),
                });
            }
        }

        // 5. Compare-and-set: hanya mengubah baris yang statusnya masih PENDING.
        const { count } = await tx.transaction.updateMany({
            where: { id: transactionId, userId, status: "PENDING" },
            data: { status: "CONFIRMED" },
        });

        if (count !== 1) {
            throw new AppError(
                409,
                "TRANSACTION_NOT_PENDING",
                "Transaction is no longer PENDING"
            );
        }

        // 6. Hitung ulang dan pastikan tidak ada saldo minus (pengaman terhadap bug logika;
        //    bila terjadi, seluruh transaksi database dibatalkan).
        const after = await getWalletBalances(tx, userId, walletIds);

        if (current.type !== "INCOME" && after.get(current.walletId).balance.lt(0)) {
            throw new Error(
                `Invariant violated: wallet ${current.walletId} would have a negative balance after confirming transaction ${current.id}`
            );
        }

        const confirmed = await tx.transaction.findUnique({ where: { id: transactionId } });

        return {
            transaction: presentTransaction(confirmed),
            balances: [...after.values()].map(({ walletId, balance }) => ({ walletId, balance })),
        };
    });
}
