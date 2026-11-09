// Pengujian Stage 2.2a: perhitungan saldo dompet.
// Jalankan dengan: npm test
// Tes membuat user dan dompet SEMENTARA (nama diawali "__test_") lalu menghapusnya kembali.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

import prisma from "../src/config/database.js";
import AppError from "../src/utils/AppError.js";
import { runInTransaction, lockWallets } from "../src/utils/dbTransaction.js";
import { getWalletBalance, getWalletBalances } from "../src/services/balanceService.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userA;
let userB;

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_balance_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_balance_b__" } });
});

after(async () => {
    // Menghapus user menghapus dompet dan transaksinya (onDelete: Cascade pada Wallet;
    // transaksi dihapus eksplisit lebih dulu karena relasinya tidak cascade).
    const ids = [userA.id, userB.id];
    await prisma.transaction.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
});

function newWallet(user, initialBalance = 0, extra = {}) {
    return prisma.wallet.create({
        data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance, ...extra },
    });
}

function addTx(user, wallet, type, amount, status = "CONFIRMED", destinationWallet = undefined) {
    return prisma.transaction.create({
        data: {
            userId: user.id,
            walletId: wallet.id,
            destinationWalletId: destinationWallet?.id,
            type,
            amount,
            status,
            transactionDate: new Date("2026-11-03T00:00:00.000Z"),
        },
    });
}

const balanceOf = async (user, wallet) =>
    (await getWalletBalance(prisma, user.id, wallet.id)).balance.toFixed(2);

describe("rumus saldo", () => {
    test("dompet tanpa transaksi: saldo sama dengan initialBalance", async () => {
        const wallet = await newWallet(userA, "150000.50");
        const result = await getWalletBalance(prisma, userA.id, wallet.id);

        assert.equal(result.balance.toFixed(2), "150000.50");
        assert.equal(result.totalIncome.toFixed(2), "0.00");
        assert.equal(result.totalExpense.toFixed(2), "0.00");
        assert.equal(result.transferIn.toFixed(2), "0.00");
        assert.equal(result.transferOut.toFixed(2), "0.00");
        assert.equal(typeof result.walletId, "bigint");
        assert.ok(Prisma.Decimal.isDecimal(result.balance));
    });

    test("INCOME menambah dan EXPENSE mengurangi", async () => {
        const wallet = await newWallet(userA, 100000);
        await addTx(userA, wallet, "INCOME", 50000);
        await addTx(userA, wallet, "INCOME", "2500.25");
        await addTx(userA, wallet, "EXPENSE", 30000);

        const result = await getWalletBalance(prisma, userA.id, wallet.id);
        assert.equal(result.totalIncome.toFixed(2), "52500.25");
        assert.equal(result.totalExpense.toFixed(2), "30000.00");
        assert.equal(result.balance.toFixed(2), "122500.25");
    });

    test("hanya CONFIRMED yang dihitung: PENDING dan CANCELLED diabaikan", async () => {
        const wallet = await newWallet(userA, 1000);
        await addTx(userA, wallet, "INCOME", 500, "CONFIRMED");
        await addTx(userA, wallet, "INCOME", 9999, "PENDING");
        await addTx(userA, wallet, "INCOME", 8888, "CANCELLED");
        await addTx(userA, wallet, "EXPENSE", 7777, "PENDING");
        await addTx(userA, wallet, "EXPENSE", 6666, "CANCELLED");
        await addTx(userA, wallet, "EXPENSE", 100, "CONFIRMED");

        assert.equal(await balanceOf(userA, wallet), "1400.00");
    });

    test("status berubah menjadi CANCELLED: dampaknya hilang dari saldo tanpa koreksi apa pun", async () => {
        const wallet = await newWallet(userA, 0);
        const income = await addTx(userA, wallet, "INCOME", 1000);
        assert.equal(await balanceOf(userA, wallet), "1000.00");

        await prisma.transaction.update({
            where: { id: income.id },
            data: { status: "CANCELLED", cancelledAt: new Date() },
        });
        assert.equal(await balanceOf(userA, wallet), "0.00");
    });

    test("TRANSFER: sumber berkurang, tujuan bertambah, total dua dompet tetap, bukan income/expense", async () => {
        const source = await newWallet(userA, 100000);
        const destination = await newWallet(userA, 20000);
        await addTx(userA, source, "TRANSFER", 35000, "CONFIRMED", destination);
        await addTx(userA, source, "TRANSFER", 99999, "PENDING", destination);
        await addTx(userA, source, "TRANSFER", 88888, "CANCELLED", destination);

        const balances = await getWalletBalances(prisma, userA.id, [source.id, destination.id]);
        const s = balances.get(source.id);
        const d = balances.get(destination.id);

        assert.equal(s.balance.toFixed(2), "65000.00");
        assert.equal(d.balance.toFixed(2), "55000.00");
        assert.equal(s.transferOut.toFixed(2), "35000.00");
        assert.equal(d.transferIn.toFixed(2), "35000.00");
        assert.equal(s.balance.plus(d.balance).toFixed(2), "120000.00");

        for (const w of [s, d]) {
            assert.equal(w.totalIncome.toFixed(2), "0.00");
            assert.equal(w.totalExpense.toFixed(2), "0.00");
        }
    });

    test("transfer bolak-balik antar dua dompet dihitung benar", async () => {
        const a = await newWallet(userA, 1000);
        const b = await newWallet(userA, 1000);
        await addTx(userA, a, "TRANSFER", 300, "CONFIRMED", b);
        await addTx(userA, b, "TRANSFER", 100, "CONFIRMED", a);

        assert.equal(await balanceOf(userA, a), "800.00");
        assert.equal(await balanceOf(userA, b), "1200.00");
    });
});

describe("presisi Decimal", () => {
    test("0.10 + 0.20 tepat 0.30 (tidak ada galat floating point)", async () => {
        const wallet = await newWallet(userA, 0);
        await addTx(userA, wallet, "INCOME", "0.10");
        await addTx(userA, wallet, "INCOME", "0.20");

        assert.equal(await balanceOf(userA, wallet), "0.30");
    });

    test("seribu transaksi kecil menjumlah tepat", async () => {
        const wallet = await newWallet(userA, 0);
        await prisma.transaction.createMany({
            data: Array.from({ length: 1000 }, () => ({
                userId: userA.id,
                walletId: wallet.id,
                type: "INCOME",
                amount: "0.10",
                status: "CONFIRMED",
                transactionDate: new Date("2026-11-03T00:00:00.000Z"),
            })),
        });

        assert.equal(await balanceOf(userA, wallet), "100.00");
    });

    test("nominal maksimum DECIMAL(15,2) tetap akurat", async () => {
        const wallet = await newWallet(userA, "9999999999999.99");
        await addTx(userA, wallet, "EXPENSE", "9999999999999.99");
        assert.equal(await balanceOf(userA, wallet), "0.00");

        await addTx(userA, wallet, "EXPENSE", "0.01");
        assert.equal(await balanceOf(userA, wallet), "-0.01");
    });
});

describe("isolasi data dan validasi dompet", () => {
    test("transaksi user lain tidak memengaruhi saldo", async () => {
        const walletA = await newWallet(userA, 1000);
        const walletB = await newWallet(userB, 5000);
        await addTx(userB, walletB, "INCOME", 777);
        await addTx(userB, walletB, "EXPENSE", 11);

        assert.equal(await balanceOf(userA, walletA), "1000.00");
        assert.equal(await balanceOf(userB, walletB), "5766.00");
    });

    test("meminta dompet milik user lain atau yang tidak ada: 404 yang sama", async () => {
        const walletOfB = await newWallet(userB, 1);

        for (const walletId of [walletOfB.id, 999999999n]) {
            await assert.rejects(
                getWalletBalance(prisma, userA.id, walletId),
                (err) => err instanceof AppError && err.statusCode === 404 && err.code === "WALLET_NOT_FOUND"
            );
        }
    });

    test("satu id milik user lain di antara id sendiri: seluruh permintaan ditolak", async () => {
        const own = await newWallet(userA, 1);
        const foreign = await newWallet(userB, 1);

        await assert.rejects(
            getWalletBalances(prisma, userA.id, [own.id, foreign.id]),
            (err) => err instanceof AppError && err.code === "WALLET_NOT_FOUND"
        );
    });

    test("dompet nonaktif tetap bisa dilihat saldonya", async () => {
        const wallet = await newWallet(userA, 250, { isActive: false });
        const result = await getWalletBalance(prisma, userA.id, wallet.id);

        assert.equal(result.isActive, false);
        assert.equal(result.balance.toFixed(2), "250.00");
    });

    test("tanpa daftar id: semua dompet milik user, terurut, tidak ada milik user lain", async () => {
        const fresh = await prisma.user.create({ data: { name: "__test_balance_fresh__" } });
        try {
            const w1 = await newWallet(fresh, 10);
            const w2 = await newWallet(fresh, 20);
            await newWallet(userB, 999);

            const all = await getWalletBalances(prisma, fresh.id);
            assert.deepEqual([...all.keys()], [w1.id, w2.id]);
            assert.equal(all.get(w2.id).balance.toFixed(2), "20.00");
        } finally {
            await prisma.user.delete({ where: { id: fresh.id } });
        }
    });

    test("id duplikat tidak bermasalah, daftar kosong menghasilkan Map kosong", async () => {
        const wallet = await newWallet(userA, 5);
        const balances = await getWalletBalances(prisma, userA.id, [wallet.id, wallet.id, String(wallet.id)]);
        assert.equal(balances.size, 1);

        assert.equal((await getWalletBalances(prisma, userA.id, [])).size, 0);
    });
});

describe("saldo turunan + lock aman terhadap transaksi bersamaan", () => {
    // Pola yang akan dipakai konfirmasi di 2.2d: kunci dompet, hitung saldo dari transaksi
    // CONFIRMED, cek cukup, lalu simpan. Di sini "konfirmasi" disimulasikan dengan membuat
    // EXPENSE CONFIRMED langsung. Ini membuktikan pola, bukan service konfirmasi itu sendiri.
    async function spend(wallet, amount, useLock) {
        return runInTransaction(async (tx) => {
            if (useLock) {
                await lockWallets(tx, userA.id, [wallet.id]);
            }

            const { balance } = await getWalletBalance(tx, userA.id, wallet.id);
            await sleep(50); // memperbesar peluang tabrakan

            if (balance.minus(amount).lt(0)) {
                throw new AppError(422, "INSUFFICIENT_BALANCE", "Insufficient balance");
            }

            await tx.transaction.create({
                data: {
                    userId: userA.id,
                    walletId: wallet.id,
                    type: "EXPENSE",
                    amount,
                    status: "CONFIRMED",
                    transactionDate: new Date("2026-11-03T00:00:00.000Z"),
                },
            });
        });
    }

    test("KONTROL tanpa lock: saldo bisa minus (hanya informasi, tidak di-assert)", async (t) => {
        const wallet = await newWallet(userA, 100);
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => spend(wallet, 30, false)));
        const ok = results.filter((r) => r.status === "fulfilled").length;

        t.diagnostic(`tanpa lock: ${ok} dari 5 pengeluaran Rp30 lolos dari saldo Rp100, saldo akhir ${await balanceOf(userA, wallet)}`);
    });

    test("dengan lock: 5 pengeluaran Rp30 bersamaan dari saldo Rp100 -> tepat 3 lolos, saldo akhir 10", async () => {
        const wallet = await newWallet(userA, 100);
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => spend(wallet, 30, true)));

        const rejected = results.filter((r) => r.status === "rejected");
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
        assert.equal(rejected.length, 2);
        for (const r of rejected) {
            assert.equal(r.reason.code, "INSUFFICIENT_BALANCE");
        }

        assert.equal(await balanceOf(userA, wallet), "10.00");
    });

    test("dengan lock, 20 pengeluaran Rp10 bersamaan dari saldo Rp100 -> tepat 10 lolos, saldo akhir 0", async () => {
        const wallet = await newWallet(userA, 100);
        const results = await Promise.allSettled(Array.from({ length: 20 }, () => spend(wallet, 10, true)));

        assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
        assert.equal(await balanceOf(userA, wallet), "0.00");
    });
});
