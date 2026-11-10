// Pengujian Stage 2.2e: pembatalan transaksi (PENDING/CONFIRMED -> CANCELLED).
// Jalankan dengan: npm test
// Tes membuat user, dompet, dan kategori SEMENTARA (nama diawali "__test_") lalu menghapusnya kembali.
// Data seed milik Anda tidak disentuh dan tidak dipakai.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/config/database.js";
import AppError from "../src/utils/AppError.js";
import { jsonReplacer } from "../src/utils/serialize.js";
import { runInTransaction, lockWallets } from "../src/utils/dbTransaction.js";
import { getWalletBalance } from "../src/services/balanceService.js";
import { createIncome, createExpense, createTransfer } from "../src/services/transactionService.js";
import { confirmTransaction } from "../src/services/confirmationService.js";
import { cancelTransaction } from "../src/services/cancellationService.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userA;
let userB;
let incomeCat;
let expenseCat;

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_cancel_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_cancel_b__" } });
    incomeCat = await prisma.category.create({ data: { userId: null, name: "__test_cx_income__", type: "INCOME" } });
    expenseCat = await prisma.category.create({ data: { userId: null, name: "__test_cx_expense__", type: "EXPENSE" } });
});

after(async () => {
    const userIds = [userA.id, userB.id];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: { in: [incomeCat.id, expenseCat.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// ---------- helper ----------

const newWallet = (user, initialBalance = 1000, extra = {}) =>
    prisma.wallet.create({
        data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance, ...extra },
    });

const common = { source: "WEB" };

async function pendingIncome(wallet, amount, user = userA) {
    const { transaction } = await createIncome(user.id, {
        ...common,
        walletId: String(wallet.id),
        categoryId: String(incomeCat.id),
        amount: String(amount),
    });
    return transaction;
}

async function pendingExpense(wallet, amount, user = userA) {
    const { transaction } = await createExpense(user.id, {
        ...common,
        walletId: String(wallet.id),
        categoryId: String(expenseCat.id),
        amount: String(amount),
    });
    return transaction;
}

async function pendingTransfer(from, to, amount, user = userA) {
    const { transaction } = await createTransfer(user.id, {
        ...common,
        walletId: String(from.id),
        destinationWalletId: String(to.id),
        amount: String(amount),
    });
    return transaction;
}

// Membuat transaksi lalu mengonfirmasinya (memakai service 2.2b/2.2c/2.2d yang sebenarnya)
async function confirmed(create, ...args) {
    const transaction = await create(...args);
    await confirmTransaction(userA.id, transaction.id);
    return transaction;
}

const balanceOf = async (wallet, user = userA) =>
    (await getWalletBalance(prisma, user.id, wallet.id)).balance.toFixed(2);

const rowOf = (transaction) => prisma.transaction.findUnique({ where: { id: transaction.id } });
const statusOf = async (transaction) => (await rowOf(transaction)).status;

const sortIds = (...ids) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function rejectsWith(promise, statusCode, code) {
    return assert.rejects(promise, (err) => {
        assert.ok(err instanceof AppError, `bukan AppError: ${err?.stack ?? err}`);
        assert.equal(err.statusCode, statusCode, `status: ${err.statusCode} (${err.code})`);
        assert.equal(err.code, code);
        return true;
    });
}

// Menahan kunci dompet (dan opsional menjalankan pekerjaan di dalamnya) dalam transaksi yang
// belum commit, sampai release() dipanggil. Dipakai untuk menguji "menunggu transaksi lain".
function holdWalletLock(walletId, work = async () => {}) {
    let release;
    const released = new Promise((resolve) => (release = resolve));
    let markLocked;
    const locked = new Promise((resolve) => (markLocked = resolve));

    const done = runInTransaction(async (tx) => {
        await lockWallets(tx, userA.id, [walletId]);
        await work(tx);
        markLocked();
        await released;
    });

    return { locked, release, done };
}

const insertConfirmed = (tx, wallet, type, amount) =>
    tx.transaction.create({
        data: {
            userId: userA.id,
            walletId: wallet.id,
            type,
            amount,
            status: "CONFIRMED",
            transactionDate: new Date(),
        },
    });

// Memulai pembatalan di latar belakang dan melacak apakah sudah selesai
function startTracked(promiseFactory) {
    const state = { settled: false };
    state.promise = promiseFactory().then(
        (value) => {
            state.settled = true;
            return { value };
        },
        (error) => {
            state.settled = true;
            return { error };
        }
    );
    return state;
}

// ---------- tes ----------

describe("aturan status", () => {
    test("PENDING berhasil dibatalkan: CANCELLED, cancelledAt terisi, saldo tidak berubah, tanpa cek saldo", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await pendingIncome(wallet, "500");
        const hugeExpense = await pendingExpense(wallet, "999999"); // melebihi saldo, tetap boleh dibatalkan

        const before = Date.now();
        const { transaction, balances } = await cancelTransaction(userA.id, income.id);
        await cancelTransaction(userA.id, hugeExpense.id);

        assert.equal(transaction.status, "CANCELLED");
        assert.equal(transaction.id, income.id);
        assert.ok(transaction.cancelledAt instanceof Date);
        assert.ok(transaction.cancelledAt.getTime() >= before - 1000);
        assert.equal(await statusOf(income), "CANCELLED");
        assert.equal(await statusOf(hugeExpense), "CANCELLED");
        assert.equal(await balanceOf(wallet), "1000.00");

        assert.equal(balances.length, 1);
        assert.equal(balances[0].walletId, wallet.id);
        assert.equal(balances[0].balance.toFixed(2), "1000.00");
    });

    test("PENDING TRANSFER dibatalkan: kedua dompet tidak berubah, hasil memuat saldo kedua dompet", async () => {
        const from = await newWallet(userA, 100);
        const to = await newWallet(userA, 50);
        const transfer = await pendingTransfer(from, to, "9999"); // jauh melebihi saldo sumber

        const { transaction, balances } = await cancelTransaction(userA.id, transfer.id);

        assert.equal(transaction.status, "CANCELLED");
        assert.equal(await balanceOf(from), "100.00");
        assert.equal(await balanceOf(to), "50.00");
        assert.deepEqual(balances.map((b) => b.walletId), sortIds(from.id, to.id));
    });

    test("CONFIRMED berhasil dibatalkan bila saldo tetap aman, dan hasil memuat saldo terbaru", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await confirmed(pendingIncome, wallet, "500");
        assert.equal(await balanceOf(wallet), "1500.00");

        const { transaction, balances } = await cancelTransaction(userA.id, income.id);

        assert.equal(transaction.status, "CANCELLED");
        assert.notEqual((await rowOf(income)).cancelledAt, null);
        assert.equal(await balanceOf(wallet), "1000.00");
        assert.equal(balances[0].balance.toFixed(2), "1000.00");
    });

    test("CANCELLED bersifat final: pembatalan ulang ditolak 409 dan tidak mengubah data apa pun", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await confirmed(pendingIncome, wallet, "500");
        await cancelTransaction(userA.id, income.id);
        const rowBefore = await rowOf(income);

        await assert.rejects(cancelTransaction(userA.id, income.id), (err) => {
            assert.equal(err.statusCode, 409);
            assert.equal(err.code, "TRANSACTION_ALREADY_CANCELLED");
            assert.deepEqual(err.details, { status: "CANCELLED" });
            return true;
        });

        const rowAfter = await rowOf(income);
        assert.equal(rowAfter.status, "CANCELLED");
        assert.equal(rowAfter.cancelledAt.getTime(), rowBefore.cancelledAt.getTime());
        assert.equal(rowAfter.updatedAt.getTime(), rowBefore.updatedAt.getTime());
        assert.equal(await balanceOf(wallet), "1000.00");
    });

    test("pembatalan ditolak 422: status CONFIRMED, cancelledAt, updatedAt, dan saldo tidak berubah", async () => {
        const wallet = await newWallet(userA, 0);
        const income = await confirmed(pendingIncome, wallet, "500");
        await confirmed(pendingExpense, wallet, "300"); // saldo 200 < 500
        const rowBefore = await rowOf(income);

        await rejectsWith(cancelTransaction(userA.id, income.id), 422, "CANCELLATION_NEGATIVE_BALANCE");

        const rowAfter = await rowOf(income);
        assert.equal(rowAfter.status, "CONFIRMED");
        assert.equal(rowAfter.cancelledAt, null);
        assert.equal(rowAfter.updatedAt.getTime(), rowBefore.updatedAt.getTime());
        assert.equal(await balanceOf(wallet), "200.00");
    });

    test("setelah dibatalkan, transaksi tidak bisa dikonfirmasi lagi (409)", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await pendingIncome(wallet, "500");
        await cancelTransaction(userA.id, income.id);

        await assert.rejects(confirmTransaction(userA.id, income.id), (err) => {
            assert.equal(err.statusCode, 409);
            assert.equal(err.code, "TRANSACTION_NOT_PENDING");
            assert.deepEqual(err.details, { status: "CANCELLED" });
            return true;
        });
        assert.equal(await statusOf(income), "CANCELLED");
        assert.equal(await balanceOf(wallet), "1000.00");
    });

    test("siklus lengkap: PENDING -> CONFIRMED -> CANCELLED mengembalikan saldo awal", async () => {
        const wallet = await newWallet(userA, 1000);
        const expense = await pendingExpense(wallet, "250.75");
        assert.equal(await balanceOf(wallet), "1000.00");

        await confirmTransaction(userA.id, expense.id);
        assert.equal(await balanceOf(wallet), "749.25");

        await cancelTransaction(userA.id, expense.id);
        assert.equal(await balanceOf(wallet), "1000.00");
        assert.equal(await statusOf(expense), "CANCELLED");
    });

    test("replay idempotency pada transaksi yang sudah dibatalkan mengembalikan status CANCELLED", async () => {
        const wallet = await newWallet(userA, 1000);
        const input = {
            ...common,
            walletId: String(wallet.id),
            categoryId: String(incomeCat.id),
            amount: "70",
            idempotencyKey: "cancel-replay-1",
        };
        const first = await createIncome(userA.id, input);
        await cancelTransaction(userA.id, first.transaction.id);

        const replayed = await createIncome(userA.id, input);
        assert.equal(replayed.created, false);
        assert.equal(replayed.transaction.id, first.transaction.id);
        assert.equal(replayed.transaction.status, "CANCELLED");
        assert.equal(replayed.transaction.idempotencyKey, "cancel-replay-1");
    });

    test("hasil aman diserialisasi ke JSON (BigInt dan Decimal menjadi string)", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await confirmed(pendingIncome, wallet, "250.5");
        const result = await cancelTransaction(userA.id, income.id);
        const json = JSON.parse(JSON.stringify({ success: true, data: result }, jsonReplacer));

        assert.equal(json.data.transaction.id, String(income.id));
        assert.equal(json.data.transaction.status, "CANCELLED");
        assert.equal(json.data.balances[0].walletId, String(wallet.id));
        assert.equal(json.data.balances[0].balance, "1000.00");
    });
});

describe("pembatalan INCOME (CONFIRMED)", () => {
    test("menghilangkan dampak pemasukan dari saldo", async () => {
        const wallet = await newWallet(userA, 100);
        const income = await confirmed(pendingIncome, wallet, "50");
        await confirmed(pendingExpense, wallet, "20"); // saldo 130
        assert.equal(await balanceOf(wallet), "130.00");

        await cancelTransaction(userA.id, income.id);
        assert.equal(await balanceOf(wallet), "80.00");
    });

    test("ditolak 422 bila saldo tidak cukup untuk menghilangkan pemasukan, dengan rincian saldo", async () => {
        const wallet = await newWallet(userA, 0);
        const income = await confirmed(pendingIncome, wallet, "100");
        await confirmed(pendingExpense, wallet, "80"); // saldo 20

        await assert.rejects(cancelTransaction(userA.id, income.id), (err) => {
            assert.equal(err.statusCode, 422);
            assert.equal(err.code, "CANCELLATION_NEGATIVE_BALANCE");
            assert.deepEqual(err.details, {
                walletId: String(wallet.id),
                balance: "20.00",
                balanceAfterCancellation: "-80.00",
            });
            return true;
        });

        assert.equal(await statusOf(income), "CONFIRMED");
        assert.equal(await balanceOf(wallet), "20.00");
    });

    test("saldo hasil pembatalan tepat 0 diperbolehkan, kurang satu sen ditolak", async () => {
        const exact = await newWallet(userA, 0);
        const incomeExact = await confirmed(pendingIncome, exact, "100");
        await cancelTransaction(userA.id, incomeExact.id);
        assert.equal(await balanceOf(exact), "0.00");

        const oneCentShort = await newWallet(userA, 0);
        const incomeShort = await confirmed(pendingIncome, oneCentShort, "100");
        await confirmed(pendingExpense, oneCentShort, "0.01"); // saldo 99.99
        await rejectsWith(cancelTransaction(userA.id, incomeShort.id), 422, "CANCELLATION_NEGATIVE_BALANCE");
        assert.equal(await balanceOf(oneCentShort), "99.99");
    });

    test("saldo awal dompet (initialBalance) ikut menjadi penopang", async () => {
        const wallet = await newWallet(userA, 100);
        const income = await confirmed(pendingIncome, wallet, "50");
        await confirmed(pendingExpense, wallet, "120"); // 100 + 50 - 120 = 30
        await rejectsWith(cancelTransaction(userA.id, income.id), 422, "CANCELLATION_NEGATIVE_BALANCE");

        const other = await newWallet(userA, 100);
        const income2 = await confirmed(pendingIncome, other, "50");
        await confirmed(pendingExpense, other, "20"); // 130
        await cancelTransaction(userA.id, income2.id);
        assert.equal(await balanceOf(other), "80.00");
    });
});

describe("pembatalan EXPENSE (CONFIRMED)", () => {
    test("mengembalikan dampak pengeluaran ke saldo dan menghitungnya dengan benar", async () => {
        const wallet = await newWallet(userA, 1000);
        const expense = await confirmed(pendingExpense, wallet, "300.30");
        assert.equal(await balanceOf(wallet), "699.70");

        const { balances } = await cancelTransaction(userA.id, expense.id);

        assert.equal(await balanceOf(wallet), "1000.00");
        assert.equal(balances[0].balance.toFixed(2), "1000.00");
    });

    test("tidak memerlukan pengecekan saldo: dompet bersaldo 0 setelah pengeluaran tetap bisa dibatalkan", async () => {
        const wallet = await newWallet(userA, 1000);
        const expense = await confirmed(pendingExpense, wallet, "1000");
        assert.equal(await balanceOf(wallet), "0.00");

        await cancelTransaction(userA.id, expense.id);
        assert.equal(await balanceOf(wallet), "1000.00");
    });
});

describe("pembatalan TRANSFER (CONFIRMED)", () => {
    test("mengembalikan dana ke dompet sumber dan mengurangi dompet tujuan secara atomik", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 200);
        const transfer = await confirmed(pendingTransfer, from, to, "400");
        assert.equal(await balanceOf(from), "600.00");
        assert.equal(await balanceOf(to), "600.00");

        const { transaction, balances } = await cancelTransaction(userA.id, transfer.id);

        assert.equal(transaction.status, "CANCELLED");
        assert.equal(await balanceOf(from), "1000.00");
        assert.equal(await balanceOf(to), "200.00");

        assert.deepEqual(balances.map((b) => b.walletId), sortIds(from.id, to.id));
        const byWallet = Object.fromEntries(balances.map((b) => [String(b.walletId), b.balance.toFixed(2)]));
        assert.equal(byWallet[String(from.id)], "1000.00");
        assert.equal(byWallet[String(to.id)], "200.00");
    });

    test("ditolak 422 bila saldo tujuan tidak cukup; KEDUA dompet dan status tetap tidak berubah", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 0);
        const transfer = await confirmed(pendingTransfer, from, to, "400"); // from 600, to 400
        await confirmed(pendingExpense, to, "300"); // to 100
        const rowBefore = await rowOf(transfer);

        await assert.rejects(cancelTransaction(userA.id, transfer.id), (err) => {
            assert.equal(err.statusCode, 422);
            assert.equal(err.code, "CANCELLATION_NEGATIVE_BALANCE");
            assert.deepEqual(err.details, {
                walletId: String(to.id), // yang dicek adalah dompet TUJUAN
                balance: "100.00",
                balanceAfterCancellation: "-300.00",
            });
            return true;
        });

        const rowAfter = await rowOf(transfer);
        assert.equal(rowAfter.status, "CONFIRMED");
        assert.equal(rowAfter.cancelledAt, null);
        assert.equal(rowAfter.updatedAt.getTime(), rowBefore.updatedAt.getTime());
        assert.equal(await balanceOf(from), "600.00");
        assert.equal(await balanceOf(to), "100.00");
    });

    test("saldo tujuan tepat sama dengan nominal diperbolehkan (tujuan menjadi 0)", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 0);
        const transfer = await confirmed(pendingTransfer, from, to, "400");

        await cancelTransaction(userA.id, transfer.id);
        assert.equal(await balanceOf(from), "1000.00");
        assert.equal(await balanceOf(to), "0.00");
    });

    test("saldo sumber tidak memengaruhi kelayakan (sumber hanya bertambah)", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 0);
        const transfer = await confirmed(pendingTransfer, from, to, "1000"); // from 0, to 1000

        await cancelTransaction(userA.id, transfer.id);
        assert.equal(await balanceOf(from), "1000.00");
        assert.equal(await balanceOf(to), "0.00");
    });
});

describe("kepemilikan dan validasi", () => {
    test("transaksi milik user lain: 404 TRANSACTION_NOT_FOUND, tidak berubah", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await confirmed(pendingIncome, wallet, "500");

        await rejectsWith(cancelTransaction(userB.id, income.id), 404, "TRANSACTION_NOT_FOUND");

        assert.equal(await statusOf(income), "CONFIRMED");
        assert.equal(await balanceOf(wallet), "1500.00");
    });

    test("transaksi tidak ditemukan: respon 404 yang sama persis dengan transaksi milik user lain", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await pendingIncome(wallet, "500");

        const capture = (promise) =>
            promise.then(
                () => assert.fail("seharusnya ditolak"),
                (err) => ({ status: err.statusCode, code: err.code, message: err.message, details: err.details })
            );

        const foreign = await capture(cancelTransaction(userB.id, income.id));
        const missing = await capture(cancelTransaction(userA.id, "999999999"));
        assert.deepEqual(foreign, missing);
        assert.equal(missing.status, 404);
    });

    test("ID tidak valid ditolak 400", async () => {
        for (const bad of ["abc", "0", "-1", 1.5, "1.5", "", null, undefined, {}, [], 0n, -1n, 9223372036854775808n, "9223372036854775808"]) {
            await rejectsWith(cancelTransaction(userA.id, bad), 400, "VALIDATION_ERROR");
        }
    });

    test("transactionId boleh berupa BigInt, string, atau angka", async () => {
        const wallet = await newWallet(userA, 1000);

        for (const toForm of [(id) => id, (id) => String(id), (id) => Number(id)]) {
            const income = await pendingIncome(wallet, "10");
            const { transaction } = await cancelTransaction(userA.id, toForm(income.id));
            assert.equal(transaction.id, income.id);
            assert.equal(transaction.status, "CANCELLED");
        }
    });

    test("dompet nonaktif mengikuti kebijakan konfirmasi: 422 WALLET_INACTIVE, status tidak berubah", async () => {
        const wallet = await newWallet(userA, 1000);
        const other = await newWallet(userA, 1000);
        const pendingInc = await pendingIncome(wallet, "100");
        const confirmedInc = await confirmed(pendingIncome, wallet, "200");
        const transferToInactive = await confirmed(pendingTransfer, other, wallet, "50");

        await prisma.wallet.update({ where: { id: wallet.id }, data: { isActive: false } });

        // Kebijakan yang sama dengan konfirmasi
        await rejectsWith(confirmTransaction(userA.id, pendingInc.id), 422, "WALLET_INACTIVE");

        // PENDING, CONFIRMED (INCOME), dan TRANSFER yang tujuannya nonaktif
        await rejectsWith(cancelTransaction(userA.id, pendingInc.id), 422, "WALLET_INACTIVE");
        await rejectsWith(cancelTransaction(userA.id, confirmedInc.id), 422, "WALLET_INACTIVE");
        await rejectsWith(cancelTransaction(userA.id, transferToInactive.id), 422, "WALLET_INACTIVE");

        assert.equal(await statusOf(pendingInc), "PENDING");
        assert.equal(await statusOf(confirmedInc), "CONFIRMED");
        assert.equal(await statusOf(transferToInactive), "CONFIRMED");
        assert.equal(await balanceOf(other), "950.00");

        // Setelah diaktifkan kembali, pembatalan berjalan normal
        await prisma.wallet.update({ where: { id: wallet.id }, data: { isActive: true } });
        await cancelTransaction(userA.id, pendingInc.id);
        await cancelTransaction(userA.id, confirmedInc.id);
        await cancelTransaction(userA.id, transferToInactive.id);
        assert.equal(await balanceOf(wallet), "1000.00");
        assert.equal(await balanceOf(other), "1000.00");
    });

    test("data user lain tidak terpengaruh oleh pembatalan", async () => {
        const walletA = await newWallet(userA, 1000);
        const walletB = await newWallet(userB, 777);
        const { transaction: incomeB } = await createIncome(userB.id, {
            ...common,
            walletId: String(walletB.id),
            categoryId: String(incomeCat.id),
            amount: "100",
        });
        await confirmTransaction(userB.id, incomeB.id);

        const incomeA = await confirmed(pendingIncome, walletA, "500");
        await cancelTransaction(userA.id, incomeA.id);

        assert.equal(await balanceOf(walletA), "1000.00");
        assert.equal(await balanceOf(walletB, userB), "877.00");
        assert.equal(await statusOf(incomeB), "CONFIRMED");
    });
});

describe("presisi Decimal", () => {
    test("0.10, 0.20, dan 0.30 dibatalkan tepat tanpa galat floating point", async () => {
        const wallet = await newWallet(userA, 0);
        const a = await confirmed(pendingIncome, wallet, "0.10");
        const b = await confirmed(pendingIncome, wallet, "0.20");
        assert.equal(await balanceOf(wallet), "0.30");

        await cancelTransaction(userA.id, a.id);
        assert.equal(await balanceOf(wallet), "0.20");

        const c = await confirmed(pendingIncome, wallet, "0.30"); // 0.50
        await cancelTransaction(userA.id, b.id); // 0.30
        assert.equal(await balanceOf(wallet), "0.30");
        await cancelTransaction(userA.id, c.id);
        assert.equal(await balanceOf(wallet), "0.00");
    });

    test("batas pecahan: pembatalan yang menyisakan -0.01 ditolak, yang menyisakan 0.00 diterima", async () => {
        const wallet = await newWallet(userA, 0);
        const income = await confirmed(pendingIncome, wallet, "0.30");
        await confirmed(pendingExpense, wallet, "0.20"); // saldo 0.10
        await rejectsWith(cancelTransaction(userA.id, income.id), 422, "CANCELLATION_NEGATIVE_BALANCE");

        const exact = await newWallet(userA, 0);
        const incomeExact = await confirmed(pendingIncome, exact, "0.30");
        await confirmed(pendingExpense, exact, "0.01"); // 0.29
        await rejectsWith(cancelTransaction(userA.id, incomeExact.id), 422, "CANCELLATION_NEGATIVE_BALANCE");
        const tiny = await confirmed(pendingIncome, exact, "0.10"); // 0.39
        await cancelTransaction(userA.id, tiny.id); // 0.29
        assert.equal(await balanceOf(exact), "0.29");
    });

    test("nominal maksimum DECIMAL(15,2) tetap akurat", async () => {
        const wallet = await newWallet(userA, 0);
        const income = await confirmed(pendingIncome, wallet, "9999999999999.99");
        assert.equal(await balanceOf(wallet), "9999999999999.99");

        await cancelTransaction(userA.id, income.id);
        assert.equal(await balanceOf(wallet), "0.00");
    });
});

describe("balapan (concurrency)", () => {
    test("8 pembatalan bersamaan pada transaksi yang sama: tepat 1 berhasil (PENDING, INCOME, TRANSFER)", async () => {
        const wallet = await newWallet(userA, 1000);
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 0);

        // Tiap kasus dibuat tepat sebelum dijalankan, supaya pengecekan saldonya tidak saling memengaruhi
        const cases = [
            { make: () => pendingIncome(wallet, "500"), check: async () => assert.equal(await balanceOf(wallet), "1000.00") },
            { make: () => confirmed(pendingIncome, wallet, "300"), check: async () => assert.equal(await balanceOf(wallet), "1000.00") },
            {
                make: () => confirmed(pendingTransfer, from, to, "400"),
                check: async () => {
                    assert.equal(await balanceOf(from), "1000.00");
                    assert.equal(await balanceOf(to), "0.00");
                },
            },
        ];

        for (const { make, check } of cases) {
            const transaction = await make();
            const results = await Promise.allSettled(
                Array.from({ length: 8 }, () => cancelTransaction(userA.id, transaction.id))
            );
            const rejected = results.filter((r) => r.status === "rejected");

            assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, rejected.map((r) => String(r.reason)).join(" | "));
            assert.equal(rejected.length, 7);
            for (const r of rejected) {
                assert.equal(r.reason.code, "TRANSACTION_ALREADY_CANCELLED");
                assert.deepEqual(r.reason.details, { status: "CANCELLED" });
            }
            assert.equal(await statusOf(transaction), "CANCELLED");
            await check();
        }
    });

    test("5 pembatalan INCOME bersamaan: hanya yang tidak membuat saldo minus yang lolos (tepat 2), saldo akhir 0", async () => {
        const wallet = await newWallet(userA, 0);
        const incomes = [];
        for (let i = 0; i < 5; i++) {
            incomes.push(await confirmed(pendingIncome, wallet, "30"));
        }
        await confirmed(pendingExpense, wallet, "90"); // saldo 150 - 90 = 60

        const results = await Promise.allSettled(incomes.map((income) => cancelTransaction(userA.id, income.id)));
        const rejected = results.filter((r) => r.status === "rejected");

        assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, rejected.map((r) => String(r.reason)).join(" | "));
        assert.equal(rejected.length, 3);
        for (const r of rejected) {
            assert.equal(r.reason.code, "CANCELLATION_NEGATIVE_BALANCE");
        }
        assert.equal(await balanceOf(wallet), "0.00");
    });

    test("pembatalan INCOME bersamaan dengan konfirmasi EXPENSE yang memakai saldo itu: tepat satu yang menang, saldo tidak minus", async () => {
        const outcomes = { cancelFirst: 0, expenseFirst: 0 };

        for (let trial = 0; trial < 6; trial++) {
            const wallet = await newWallet(userA, 0);
            const income = await confirmed(pendingIncome, wallet, "100");
            const expense = await pendingExpense(wallet, "80");

            const calls = [
                () => cancelTransaction(userA.id, income.id),
                () => confirmTransaction(userA.id, expense.id),
            ];
            if (trial % 2 === 1) calls.reverse(); // variasi urutan permulaan
            const settled = await Promise.allSettled(calls.map((call) => call()));
            const cancelResult = trial % 2 === 1 ? settled[1] : settled[0];
            const confirmResult = trial % 2 === 1 ? settled[0] : settled[1];

            assert.equal([cancelResult, confirmResult].filter((r) => r.status === "fulfilled").length, 1);

            const balance = await balanceOf(wallet);
            if (cancelResult.status === "fulfilled") {
                outcomes.cancelFirst++;
                assert.equal(confirmResult.reason.code, "INSUFFICIENT_BALANCE");
                assert.equal(await statusOf(income), "CANCELLED");
                assert.equal(await statusOf(expense), "PENDING");
                assert.equal(balance, "0.00");
            } else {
                outcomes.expenseFirst++;
                assert.equal(cancelResult.reason.code, "CANCELLATION_NEGATIVE_BALANCE");
                assert.equal(await statusOf(income), "CONFIRMED");
                assert.equal(await statusOf(expense), "CONFIRMED");
                assert.equal(balance, "20.00");
            }
        }
        assert.equal(outcomes.cancelFirst + outcomes.expenseFirst, 6);
    });

    test("pembatalan TRANSFER bersamaan dengan konfirmasi pengeluaran pada dompet TUJUAN: tepat satu yang menang", async () => {
        for (let trial = 0; trial < 6; trial++) {
            const from = await newWallet(userA, 1000);
            const to = await newWallet(userA, 0);
            const transfer = await confirmed(pendingTransfer, from, to, "100"); // to = 100
            const expense = await pendingExpense(to, "60");

            const calls = [
                () => cancelTransaction(userA.id, transfer.id),
                () => confirmTransaction(userA.id, expense.id),
            ];
            if (trial % 2 === 1) calls.reverse();
            const settled = await Promise.allSettled(calls.map((call) => call()));
            const cancelResult = trial % 2 === 1 ? settled[1] : settled[0];
            const confirmResult = trial % 2 === 1 ? settled[0] : settled[1];

            assert.equal([cancelResult, confirmResult].filter((r) => r.status === "fulfilled").length, 1);

            if (cancelResult.status === "fulfilled") {
                assert.equal(confirmResult.reason.code, "INSUFFICIENT_BALANCE");
                assert.equal(await balanceOf(to), "0.00");
                assert.equal(await balanceOf(from), "1000.00");
            } else {
                assert.equal(cancelResult.reason.code, "CANCELLATION_NEGATIVE_BALANCE");
                assert.equal(await balanceOf(to), "40.00");
                assert.equal(await balanceOf(from), "900.00");
            }
        }
    });

    test("pembatalan TRANSFER bersamaan dengan konfirmasi pengeluaran pada dompet SUMBER: saldo selalu konsisten", async () => {
        for (let trial = 0; trial < 6; trial++) {
            const from = await newWallet(userA, 100);
            const to = await newWallet(userA, 500);
            const transfer = await confirmed(pendingTransfer, from, to, "100"); // from 0, to 600
            const expense = await pendingExpense(from, "100");

            const calls = [
                () => cancelTransaction(userA.id, transfer.id),
                () => confirmTransaction(userA.id, expense.id),
            ];
            if (trial % 2 === 1) calls.reverse();
            const settled = await Promise.allSettled(calls.map((call) => call()));
            const cancelResult = trial % 2 === 1 ? settled[1] : settled[0];
            const confirmResult = trial % 2 === 1 ? settled[0] : settled[1];

            // Pembatalan selalu berhasil (dompet tujuan punya 600 >= 100)
            assert.equal(cancelResult.status, "fulfilled", String(cancelResult.reason));
            assert.equal(await balanceOf(to), "500.00");

            if (confirmResult.status === "fulfilled") {
                // pembatalan lebih dulu: dana kembali ke sumber, lalu dipakai pengeluaran
                assert.equal(await balanceOf(from), "0.00");
            } else {
                // pengeluaran lebih dulu ditolak (saldo 0), lalu pembatalan mengembalikan dana
                assert.equal(confirmResult.reason.code, "INSUFFICIENT_BALANCE");
                assert.equal(await balanceOf(from), "100.00");
            }
        }
    });

    for (const kind of ["INCOME", "EXPENSE", "TRANSFER"]) {
        test(`konfirmasi dan pembatalan bersamaan pada ${kind} PENDING yang sama: hasil akhir selalu CANCELLED dan saldo kembali awal`, async () => {
            for (let trial = 0; trial < 6; trial++) {
                const wallet = await newWallet(userA, 1000);
                const other = await newWallet(userA, 1000);
                const transaction =
                    kind === "INCOME"
                        ? await pendingIncome(wallet, "100")
                        : kind === "EXPENSE"
                          ? await pendingExpense(wallet, "100")
                          : await pendingTransfer(wallet, other, "100");

                const calls = [
                    () => cancelTransaction(userA.id, transaction.id),
                    () => confirmTransaction(userA.id, transaction.id),
                ];
                if (trial % 2 === 1) calls.reverse();
                const settled = await Promise.allSettled(calls.map((call) => call()));
                const cancelResult = trial % 2 === 1 ? settled[1] : settled[0];
                const confirmResult = trial % 2 === 1 ? settled[0] : settled[1];

                // Pembatalan selalu berhasil, baik sebelum maupun sesudah konfirmasi
                assert.equal(cancelResult.status, "fulfilled", String(cancelResult.reason));
                if (confirmResult.status === "rejected") {
                    assert.equal(confirmResult.reason.code, "TRANSACTION_NOT_PENDING");
                    assert.deepEqual(confirmResult.reason.details, { status: "CANCELLED" });
                }

                assert.equal(await statusOf(transaction), "CANCELLED");
                assert.equal(await balanceOf(wallet), "1000.00");
                assert.equal(await balanceOf(other), "1000.00");
            }
        });
    }

    test("12 transfer dua arah (6 A->B dan 6 B->A) dibatalkan bersamaan: semua selesai tanpa deadlock", async () => {
        const a = await newWallet(userA, 1000);
        const b = await newWallet(userA, 1000);

        const transfers = [];
        for (let i = 0; i < 6; i++) {
            transfers.push(await confirmed(pendingTransfer, a, b, "10"));
            transfers.push(await confirmed(pendingTransfer, b, a, "10"));
        }

        const results = await Promise.allSettled(transfers.map((t) => cancelTransaction(userA.id, t.id)));
        const failures = results.filter((r) => r.status === "rejected");

        assert.equal(failures.length, 0, failures.map((r) => String(r.reason)).join(" | "));
        assert.equal(await balanceOf(a), "1000.00");
        assert.equal(await balanceOf(b), "1000.00");
        for (const t of transfers) {
            assert.equal(await statusOf(t), "CANCELLED");
        }
    });

    test("pembatalan dan konfirmasi transfer dua arah dicampur bersamaan: tanpa deadlock, saldo akhir benar", async () => {
        const a = await newWallet(userA, 1000);
        const b = await newWallet(userA, 1000);

        const toCancel = [];
        const toConfirm = [];
        for (let i = 0; i < 6; i++) {
            toCancel.push(await confirmed(pendingTransfer, b, a, "10")); // B->A sudah CONFIRMED
            toConfirm.push(await pendingTransfer(a, b, "10")); // A->B masih PENDING
        }

        const operations = [
            ...toCancel.map((t) => cancelTransaction(userA.id, t.id)),
            ...toConfirm.map((t) => confirmTransaction(userA.id, t.id)),
        ];
        const results = await Promise.allSettled(operations);
        const failures = results.filter((r) => r.status === "rejected");

        assert.equal(failures.length, 0, failures.map((r) => String(r.reason)).join(" | "));
        // B->A dibatalkan (netral), A->B dikonfirmasi: A keluar 60, B masuk 60
        assert.equal(await balanceOf(a), "940.00");
        assert.equal(await balanceOf(b), "1060.00");
    });

    // Pengecekan-lalu-bertindak: saat transaksi lain sudah memakai saldo tetapi belum commit,
    // pembatalan HARUS menunggu lalu memakai saldo terbaru. Tanpa penguncian, pembatalan akan
    // membaca saldo lama dan meloloskan pembatalan yang membuat saldo minus.
    test("pembatalan INCOME menunggu transaksi lain yang belum commit lalu memakai saldo terbaru (ditolak)", async () => {
        const wallet = await newWallet(userA, 0);
        const income = await confirmed(pendingIncome, wallet, "100"); // saldo 100

        const holder = holdWalletLock(wallet.id, (tx) => insertConfirmed(tx, wallet, "EXPENSE", "80")); // belum commit

        let attempt;
        try {
            await holder.locked;
            attempt = startTracked(() => cancelTransaction(userA.id, income.id));
            await sleep(400);
            assert.equal(attempt.settled, false, "pembatalan tidak menunggu penguncian dompet");
        } finally {
            holder.release();
        }

        await holder.done;
        const outcome = await attempt.promise;

        // Saldo terbaru = 100 - 80 = 20 < 100, jadi harus ditolak
        assert.ok(outcome.error, "pembatalan seharusnya ditolak karena saldo terbaru tidak cukup");
        assert.equal(outcome.error.code, "CANCELLATION_NEGATIVE_BALANCE");
        assert.equal(outcome.error.details.balance, "20.00");
        assert.equal(await statusOf(income), "CONFIRMED");
        assert.equal(await balanceOf(wallet), "20.00");
    });

    test("pembatalan INCOME menunggu transaksi lain yang belum commit lalu memakai saldo terbaru (diterima)", async () => {
        const wallet = await newWallet(userA, 0);
        const income = await confirmed(pendingIncome, wallet, "100");
        await confirmed(pendingExpense, wallet, "60"); // saldo 40: dengan saldo lama, pembatalan ditolak

        const holder = holdWalletLock(wallet.id, (tx) => insertConfirmed(tx, wallet, "INCOME", "70")); // belum commit

        let attempt;
        try {
            await holder.locked;
            attempt = startTracked(() => cancelTransaction(userA.id, income.id));
            await sleep(400);
            assert.equal(attempt.settled, false, "pembatalan tidak menunggu penguncian dompet");
        } finally {
            holder.release();
        }

        await holder.done;
        const outcome = await attempt.promise;

        // Saldo terbaru = 40 + 70 = 110 >= 100, jadi harus diterima (saldo akhir 10)
        assert.ok(outcome.value, `pembatalan seharusnya diterima: ${outcome.error}`);
        assert.equal(outcome.value.transaction.status, "CANCELLED");
        assert.equal(await balanceOf(wallet), "10.00");
    });

    test("pembatalan TRANSFER menunggu transaksi lain pada dompet TUJUAN yang belum commit lalu memakai saldo terbaru", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 0);
        const transfer = await confirmed(pendingTransfer, from, to, "100"); // to = 100

        const holder = holdWalletLock(to.id, (tx) => insertConfirmed(tx, to, "EXPENSE", "80")); // to jadi 20, belum commit

        let attempt;
        try {
            await holder.locked;
            attempt = startTracked(() => cancelTransaction(userA.id, transfer.id));
            await sleep(400);
            assert.equal(attempt.settled, false, "pembatalan transfer tidak menunggu penguncian dompet tujuan");
        } finally {
            holder.release();
        }

        await holder.done;
        const outcome = await attempt.promise;

        assert.ok(outcome.error, "pembatalan seharusnya ditolak karena saldo terbaru tujuan tidak cukup");
        assert.equal(outcome.error.code, "CANCELLATION_NEGATIVE_BALANCE");
        assert.equal(outcome.error.details.walletId, String(to.id));
        assert.equal(outcome.error.details.balance, "20.00");
        assert.equal(await statusOf(transfer), "CONFIRMED");
        assert.equal(await balanceOf(from), "900.00");
        assert.equal(await balanceOf(to), "20.00");
    });

    test("pembatalan TRANSFER juga menunggu kunci dompet SUMBER", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 0);
        const transfer = await confirmed(pendingTransfer, from, to, "100");

        const holder = holdWalletLock(from.id);

        let attempt;
        try {
            await holder.locked;
            attempt = startTracked(() => cancelTransaction(userA.id, transfer.id));
            await sleep(400);
            assert.equal(attempt.settled, false, "pembatalan transfer tidak menunggu penguncian dompet sumber");
        } finally {
            holder.release();
        }

        await holder.done;
        const outcome = await attempt.promise;
        assert.ok(outcome.value, `pembatalan seharusnya diterima: ${outcome.error}`);
        assert.equal(await balanceOf(from), "1000.00");
        assert.equal(await balanceOf(to), "0.00");
    });

    test("pembatalan pada dompet yang berbeda tidak saling menunggu", async () => {
        const w1 = await newWallet(userA, 1000);
        const w2 = await newWallet(userA, 1000);
        const t1 = await pendingExpense(w1, "10");
        const t2 = await pendingExpense(w2, "10");

        const holder = holdWalletLock(w1.id);

        try {
            await holder.locked;
            const started = Date.now();
            await cancelTransaction(userA.id, t2.id);
            assert.ok(Date.now() - started < 3000, "pembatalan menunggu dompet yang tidak terlibat");
        } finally {
            holder.release();
            await holder.done;
        }

        await cancelTransaction(userA.id, t1.id);
    });
});
