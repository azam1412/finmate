import prisma from "../config/database.js";
import AppError from "../utils/AppError.js";
import { parseId } from "../utils/validators.js";
import { parseTransactionListQuery, assertNoQuery } from "../utils/queryValidators.js";
import { presentTransaction } from "./transactionService.js";

// MEMBACA TRANSAKSI (Stage 2.3c). Hanya membaca: tidak mengunci dompet, tidak mengubah data,
// sehingga tidak bisa deadlock dengan pembuatan, konfirmasi, atau pembatalan.
//
// ATURAN KEAMANAN: setiap query WAJIB memuat `userId` pada klausa where. userId berasal dari
// parameter pertama (req.user.id), tidak pernah dari query string.
// Setiap baris dilewatkan ke presentTransaction() supaya idempotencyKey dikembalikan TANPA awalan
// "{userId}:" yang dipakai di database.
//
// Urutan tetap: transactionDate terbaru dulu, lalu id terbesar dulu sebagai tie-breaker
// (didukung index (user_id, transaction_date)).

/**
 * Daftar transaksi milik user, dengan filter dan pagination.
 *
 * Filter (digabung dengan AND): type, status, source, walletId, categoryId, from, to.
 *  - walletId cocok bila dompet itu sumber ATAU tujuan (transfer).
 *  - categoryId tidak pernah cocok dengan TRANSFER (transfer tidak punya kategori).
 *  - walletId/categoryId yang tidak ada atau milik user lain memberi daftar kosong, bukan error.
 *  - from dan to inklusif.
 *
 * @param userId BigInt, dari req.user.id
 * @param query  req.query (belum divalidasi)
 * @returns { transactions, pagination: { page, limit, total, totalPages } }
 * @throws AppError 400 VALIDATION_ERROR
 */
export async function listTransactions(userIdInput, query) {
    const userId = BigInt(userIdInput);
    const { filters, page, limit } = parseTransactionListQuery(query);

    const where = { userId };

    if (filters.type) where.type = filters.type;
    if (filters.status) where.status = filters.status;
    if (filters.source) where.source = filters.source;
    if (filters.categoryId !== undefined) where.categoryId = filters.categoryId;

    if (filters.walletId !== undefined) {
        where.OR = [{ walletId: filters.walletId }, { destinationWalletId: filters.walletId }];
    }

    if (filters.from || filters.to) {
        where.transactionDate = {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
        };
    }

    // Dua query baca berurutan. Bila ada transaksi baru di antaranya, total dan isi halaman
    // bisa berbeda tipis; ini perilaku yang didokumentasikan untuk pagination berbasis halaman.
    const rows = await prisma.transaction.findMany({
        where,
        orderBy: [{ transactionDate: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
    });
    const total = await prisma.transaction.count({ where });

    return {
        transactions: rows.map(presentTransaction),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
}

/**
 * Detail satu transaksi milik user.
 *
 * @param userId        BigInt, dari req.user.id
 * @param transactionId id transaksi (BigInt/string/number)
 * @param query         req.query; harus kosong
 * @returns transaksi (bentuk sama dengan hasil pembuatan)
 * @throws AppError 400 VALIDATION_ERROR | 404 TRANSACTION_NOT_FOUND
 */
export async function getTransaction(userIdInput, transactionIdInput, query = {}) {
    const userId = BigInt(userIdInput);
    assertNoQuery(query);
    const transactionId = parseId(transactionIdInput, "transactionId");

    const row = await prisma.transaction.findFirst({ where: { id: transactionId, userId } });

    // Tidak ada dan milik user lain memberi respons yang sama.
    if (!row) {
        throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found");
    }

    return presentTransaction(row);
}
