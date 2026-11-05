import { Prisma } from "@prisma/client";
import prisma from "../config/database.js";
import AppError from "./AppError.js";

// STRATEGI ANTI RACE CONDITION UNTUK OPERASI SALDO
//
// Masalah: dua request bersamaan sama-sama membaca saldo Rp100, sama-sama mengeluarkan Rp80,
// keduanya lolos pengecekan, dan saldo akhir menjadi minus.
//
// Solusi (dipakai oleh semua service transaksi di langkah berikutnya):
//   1. Jalankan semuanya di dalam SATU database transaction (runInTransaction).
//   2. Di awal transaksi, KUNCI baris dompet yang terlibat (lockWallets -> SELECT ... FOR UPDATE).
//      Request lain untuk dompet yang sama akan menunggu sampai transaksi ini selesai.
//   3. Setelah terkunci, baru hitung saldo, cek aturan "tidak boleh minus", lalu simpan.
//   4. Dompet selalu dikunci berurutan dari id terkecil, supaya dua transfer yang saling
//      berlawanan arah (A->B dan B->A) tidak saling menunggu selamanya (deadlock).
//
// Isolation level READ COMMITTED dipilih agar setiap query setelah penguncian
// selalu membaca data terbaru yang sudah di-commit oleh request sebelumnya.

export function runInTransaction(callback) {
    return prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5000,
        timeout: 15000,
    });
}

// Mengunci dompet milik user dan sekaligus memvalidasi kepemilikannya.
// Harus dipanggil di dalam runInTransaction, dengan `tx` sebagai parameter pertama.
//
// - userId   : id pemilik (BigInt) -> dompet milik user lain dianggap "tidak ditemukan"
// - walletIds: satu atau lebih id dompet (BigInt/string/number); duplikat dibuang otomatis
// - requireActive: true (default) menolak dompet yang nonaktif
//
// Mengembalikan array dompet terurut berdasarkan id: { id, name, isActive, initialBalance }
export async function lockWallets(tx, userId, walletIds, { requireActive = true } = {}) {
    const ids = [...new Set(walletIds.map((id) => BigInt(id)))].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0
    );

    if (ids.length === 0) {
        throw new Error("lockWallets requires at least one wallet id");
    }

    const rows = await tx.$queryRaw(Prisma.sql`
        SELECT id, name, is_active AS isActive, initial_balance AS initialBalance
        FROM wallets
        WHERE user_id = ${userId} AND id IN (${Prisma.join(ids)})
        ORDER BY id ASC
        FOR UPDATE
    `);

    // Dompet yang tidak ada ATAU milik user lain memberi respon yang sama,
    // agar pengguna tidak bisa menebak id dompet milik orang lain.
    if (rows.length !== ids.length) {
        throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found");
    }

    const wallets = rows.map((row) => ({
        id: BigInt(row.id),
        name: row.name,
        isActive: Boolean(Number(row.isActive)),
        initialBalance: new Prisma.Decimal(row.initialBalance),
    }));

    if (requireActive) {
        const inactive = wallets.find((wallet) => !wallet.isActive);

        if (inactive) {
            throw new AppError(422, "WALLET_INACTIVE", `Wallet "${inactive.name}" is not active`);
        }
    }

    return wallets;
}
