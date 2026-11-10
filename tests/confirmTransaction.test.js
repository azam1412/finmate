// Pengujian Stage 2.2d: konfirmasi transaksi (PENDING -> CONFIRMED).
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userA;
let userB;
let incomeCat;
let expenseCat;

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_confirm_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_confirm_b__" } });
    incomeCat = await prisma.category.create({ data: { userId: null, name: "__test_cf_income__", type: "INCOME" } });
    expenseCat = await prisma.category.create({ data: { userId: null, name: "__test_cf_expense__", type: "EXPENSE" } });
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

const balanceOf = async (wallet, user = userA) =>
    (await getWalletBalance(prisma, user.id, wallet.id)).balance.toFixed(2);

const statusOf = async (transaction) =>
    (await prisma.transaction.findUnique({ where: { id: transaction.id } })).status;

const countByStatus = (walletIds, status) =>
    prisma.transaction.count({ where: { walletId: { in: walletIds }, status } });

function rejectsWith(promise, statusCode, code) {
    return assert.rejects(promise, (err) => {
        assert.ok(err instanceof AppError, `bukan AppError: ${err?.stack ?? err}`);
        assert.equal(err.statusCode, statusCode, `status: ${err.statusCode} (${err.code})`);
        assert.equal(err.code, code);
        return true;
    });
}

// ---------- tes ----------

describe("konfirmasi INCOME", () => {
    test("menambah saldo: PENDING tidak dihitung, setelah CONFIRMED dihitung", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await pendingIncome(wallet, "500");
        assert.equal(await balanceOf(wallet), "1000.00");

        const { transaction, balances } = await confirmTransaction(userA.id, income.id);

        assert.equal(transaction.status, "CONFIRMED");
        assert.equal(transaction.id, income.id);
        assert.equal(await statusOf(income), "CONFIRMED");
        assert.equal(await balanceOf(wallet), "1500.00");

        assert.equal(balances.length, 1);
        assert.equal(balances[0].walletId, wallet.id);
        assert.equal(balances[0].balance.toFixed(2), "1500.00");
    });

    test("INCOME tidak memerlukan pengecekan saldo (dompet bersaldo 0 tetap bisa)", async () => {
        const wallet = await newWallet(userA, 0);
        const income = await pendingIncome(wallet, "0.01");
        await confirmTransaction(userA.id, income.id);
        assert.equal(await balanceOf(wallet), "0.01");
    });

    test("hasil aman diserialisasi ke JSON (BigInt dan Decimal menjadi string)", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await pendingIncome(wallet, "250.5");
        const result = await confirmTransaction(userA.id, String(income.id));
        const json = JSON.parse(JSON.stringify({ success: true, data: result }, jsonReplacer));

        assert.equal(json.data.transaction.id, String(income.id));
        assert.equal(json.data.transaction.status, "CONFIRMED");
        assert.equal(json.data.balances[0].walletId, String(wallet.id));
        assert.equal(json.data.balances[0].balance, "1250.50");
    });
});

describe("konfirmasi EXPENSE (saldo harus cukup)", () => {
    test("saldo cukup: saldo berkurang", async () => {
        const wallet = await newWallet(userA, 1000);
        const expense = await pendingExpense(wallet, "300");

        const { transaction, balances } = await confirmTransaction(userA.id, expense.id);

        assert.equal(transaction.status, "CONFIRMED");
        assert.equal(await balanceOf(wallet), "700.00");
        assert.equal(balances[0].balance.toFixed(2), "700.00");
    });

    test("nominal tepat sama dengan saldo diperbolehkan dan saldo menjadi 0", async () => {
        const wallet = await newWallet(userA, 1000);
        const expense = await pendingExpense(wallet, "1000");

        await confirmTransaction(userA.id, expense.id);
        assert.equal(await balanceOf(wallet), "0.00");
    });

    test("kurang satu sen ditolak 422, transaksi tetap PENDING, saldo tidak berubah", async () => {
        const wallet = await newWallet(userA, 1000);
        const expense = await pendingExpense(wallet, "1000.01");

        await assert.rejects(confirmTransaction(userA.id, expense.id), (err) => {
            assert.equal(err.statusCode, 422);
            assert.equal(err.code, "INSUFFICIENT_BALANCE");
            assert.deepEqual(err.details, {
                walletId: String(wallet.id),
                available: "1000.00",
                required: "1000.01",
            });
            return true;
        });

        assert.equal(await statusOf(expense), "PENDING");
        assert.equal(await balanceOf(wallet), "1000.00");
    });

    test("transaksi PENDING lain tidak dihitung: pemasukan yang belum dikonfirmasi tidak membantu", async () => {
        const wallet = await newWallet(userA, 100);
        const income = await pendingIncome(wallet, "1000");
        const expense = await pendingExpense(wallet, "500");

        await rejectsWith(confirmTransaction(userA.id, expense.id), 422, "INSUFFICIENT_BALANCE");

        // Setelah pemasukan dikonfirmasi, pengeluaran yang sama boleh dikonfirmasi
        await confirmTransaction(userA.id, income.id);
        await confirmTransaction(userA.id, expense.id);
        assert.equal(await balanceOf(wallet), "600.00");
    });

    test("presisi Decimal: 0.10 + 0.20 dibelanjakan tepat 0.30 tanpa galat floating point", async () => {
        const wallet = await newWallet(userA, 0);
        await confirmTransaction(userA.id, (await pendingIncome(wallet, "0.10")).id);
        await confirmTransaction(userA.id, (await pendingIncome(wallet, "0.20")).id);

        const expense = await pendingExpense(wallet, "0.30");
        await confirmTransaction(userA.id, expense.id);
        assert.equal(await balanceOf(wallet), "0.00");

        const tooMuch = await pendingExpense(wallet, "0.01");
        await rejectsWith(confirmTransaction(userA.id, tooMuch.id), 422, "INSUFFICIENT_BALANCE");
    });
});

describe("konfirmasi TRANSFER (saldo sumber harus cukup, dua dompet atomik)", () => {
    test("saldo sumber berkurang, tujuan bertambah, total dua dompet tetap", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 200);
        const transfer = await pendingTransfer(from, to, "400");

        const { transaction, balances } = await confirmTransaction(userA.id, transfer.id);

        assert.equal(transaction.status, "CONFIRMED");
        assert.equal(await balanceOf(from), "600.00");
        assert.equal(await balanceOf(to), "600.00");

        // Hasil memuat saldo KEDUA dompet, terurut menurut id
        assert.equal(balances.length, 2);
        assert.deepEqual(balances.map((b) => b.walletId), [from.id, to.id].sort((a, b) => (a < b ? -1 : 1)));
        const byWallet = Object.fromEntries(balances.map((b) => [String(b.walletId), b.balance.toFixed(2)]));
        assert.equal(byWallet[String(from.id)], "600.00");
        assert.equal(byWallet[String(to.id)], "600.00");
    });

    test("nominal tepat sama dengan saldo sumber diperbolehkan", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 0);
        await confirmTransaction(userA.id, (await pendingTransfer(from, to, "1000")).id);

        assert.equal(await balanceOf(from), "0.00");
        assert.equal(await balanceOf(to), "1000.00");
    });

    test("saldo sumber kurang: ditolak 422 dan KEDUA dompet tetap tidak berubah, transaksi tetap PENDING", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 200);
        const transfer = await pendingTransfer(from, to, "1000.01");

        await rejectsWith(confirmTransaction(userA.id, transfer.id), 422, "INSUFFICIENT_BALANCE");

        assert.equal(await statusOf(transfer), "PENDING");
        assert.equal(await balanceOf(from), "1000.00");
        assert.equal(await balanceOf(to), "200.00");
    });

    test("saldo dompet tujuan tidak memengaruhi kelayakan (yang dicek hanya sumber)", async () => {
        const from = await newWallet(userA, 10);
        const to = await newWallet(userA, 999999);
        const transfer = await pendingTransfer(from, to, "50");

        await rejectsWith(confirmTransaction(userA.id, transfer.id), 422, "INSUFFICIENT_BALANCE");
    });

    test("transfer bolak-balik dengan nominal sama: saldo kembali seperti semula", async () => {
        const a = await newWallet(userA, 500);
        const b = await newWallet(userA, 500);
        await confirmTransaction(userA.id, (await pendingTransfer(a, b, "123.45")).id);
        await confirmTransaction(userA.id, (await pendingTransfer(b, a, "123.45")).id);

        assert.equal(await balanceOf(a), "500.00");
        assert.equal(await balanceOf(b), "500.00");
    });
});

describe("aturan status", () => {
    test("konfirmasi kedua kali ditolak 409 dan tidak diproses ganda (INCOME, EXPENSE, TRANSFER)", async () => {
        const wallet = await newWallet(userA, 1000);
        const other = await newWallet(userA, 1000);

        const income = await pendingIncome(wallet, "100");
        const expense = await pendingExpense(wallet, "30");
        const transfer = await pendingTransfer(wallet, other, "50");

        for (const transaction of [income, expense, transfer]) {
            await confirmTransaction(userA.id, transaction.id);
        }
        // 1000 + 100 - 30 - 50 = 1020 ; other = 1050
        assert.equal(await balanceOf(wallet), "1020.00");
        assert.equal(await balanceOf(other), "1050.00");

        for (const transaction of [income, expense, transfer]) {
            await assert.rejects(confirmTransaction(userA.id, transaction.id), (err) => {
                assert.equal(err.statusCode, 409);
                assert.equal(err.code, "TRANSACTION_NOT_PENDING");
                assert.deepEqual(err.details, { status: "CONFIRMED" });
                return true;
            });
        }

        assert.equal(await balanceOf(wallet), "1020.00");
        assert.equal(await balanceOf(other), "1050.00");
    });

    test("transaksi CANCELLED tidak boleh dikonfirmasi: 409, status dan saldo tidak berubah", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await pendingIncome(wallet, "500");

        await prisma.transaction.update({
            where: { id: income.id },
            data: { status: "CANCELLED", cancelledAt: new Date() },
        });

        await assert.rejects(confirmTransaction(userA.id, income.id), (err) => {
            assert.equal(err.statusCode, 409);
            assert.equal(err.code, "TRANSACTION_NOT_PENDING");
            assert.deepEqual(err.details, { status: "CANCELLED" });
            assert.match(err.message, /cancelled/i);
            return true;
        });

        assert.equal(await statusOf(income), "CANCELLED");
        assert.equal(await balanceOf(wallet), "1000.00");
    });

    test("transaksi yang sudah dikonfirmasi tetap bisa diambil lewat replay idempotency dengan status CONFIRMED", async () => {
        const wallet = await newWallet(userA, 1000);
        const input = {
            ...common,
            walletId: String(wallet.id),
            categoryId: String(incomeCat.id),
            amount: "70",
            idempotencyKey: "confirm-replay-1",
        };
        const first = await createIncome(userA.id, input);
        await confirmTransaction(userA.id, first.transaction.id);

        const replayed = await createIncome(userA.id, input);
        assert.equal(replayed.created, false);
        assert.equal(replayed.transaction.id, first.transaction.id);
        assert.equal(replayed.transaction.status, "CONFIRMED");
        assert.equal(replayed.transaction.idempotencyKey, "confirm-replay-1");
        assert.equal(await balanceOf(wallet), "1070.00");
    });

    test("hasil konfirmasi mempertahankan kunci idempotency tanpa awalan userId", async () => {
        const wallet = await newWallet(userA, 1000);
        const { transaction } = await createIncome(userA.id, {
            ...common,
            walletId: String(wallet.id),
            categoryId: String(incomeCat.id),
            amount: "10",
            idempotencyKey: "confirm-key-1",
        });

        const confirmed = await confirmTransaction(userA.id, transaction.id);
        assert.equal(confirmed.transaction.idempotencyKey, "confirm-key-1");
    });
});

describe("kepemilikan dan validasi", () => {
    test("transaksi milik user lain: 404 TRANSACTION_NOT_FOUND, tidak berubah", async () => {
        const wallet = await newWallet(userA, 1000);
        const income = await pendingIncome(wallet, "500");

        await rejectsWith(confirmTransaction(userB.id, income.id), 404, "TRANSACTION_NOT_FOUND");

        assert.equal(await statusOf(income), "PENDING");
        assert.equal(await balanceOf(wallet), "1000.00");
    });

    test("transaksi tidak ada: 404 yang sama dengan transaksi milik user lain", async () => {
        await rejectsWith(confirmTransaction(userA.id, "999999999"), 404, "TRANSACTION_NOT_FOUND");
    });

    test("transactionId tidak valid ditolak 400", async () => {
        for (const bad of ["abc", "0", "-1", 1.5, "1.5", null, undefined, {}, 0n, -1n, 9223372036854775808n, "9223372036854775808"]) {
            await rejectsWith(confirmTransaction(userA.id, bad), 400, "VALIDATION_ERROR");
        }
    });

    test("transactionId boleh berupa BigInt, string, atau angka", async () => {
        const wallet = await newWallet(userA, 0);
        const forms = [(id) => id, (id) => String(id), (id) => Number(id)];

        for (const toForm of forms) {
            const income = await pendingIncome(wallet, "10");
            const { transaction } = await confirmTransaction(userA.id, toForm(income.id));
            assert.equal(transaction.id, income.id);
        }
        assert.equal(await balanceOf(wallet), "30.00");
    });

    test("dompet yang dinonaktifkan sejak transaksi dibuat: 422 WALLET_INACTIVE, tetap PENDING", async () => {
        const wallet = await newWallet(userA, 1000);
        const other = await newWallet(userA, 1000);
        const income = await pendingIncome(wallet, "100");
        const transfer = await pendingTransfer(other, wallet, "100");

        await prisma.wallet.update({ where: { id: wallet.id }, data: { isActive: false } });

        // Dompet nonaktif sebagai tujuan INCOME dan sebagai tujuan TRANSFER
        await rejectsWith(confirmTransaction(userA.id, income.id), 422, "WALLET_INACTIVE");
        await rejectsWith(confirmTransaction(userA.id, transfer.id), 422, "WALLET_INACTIVE");

        assert.equal(await statusOf(income), "PENDING");
        assert.equal(await statusOf(transfer), "PENDING");
        assert.equal(await balanceOf(wallet), "1000.00");
        assert.equal(await balanceOf(other), "1000.00");
    });

    test("konfirmasi transaksi user A tidak memengaruhi saldo dompet user B", async () => {
        const walletA = await newWallet(userA, 1000);
        const walletB = await newWallet(userB, 777);
        await confirmTransaction(userA.id, (await pendingIncome(walletA, "500")).id);

        assert.equal(await balanceOf(walletA), "1500.00");
        assert.equal(await balanceOf(walletB, userB), "777.00");
    });
});

describe("balapan (concurrency)", () => {
    for (const [label, makePending, expectedBalance, expectedOther] of [
        ["INCOME", (w) => pendingIncome(w, "500"), "1500.00", null],
        ["EXPENSE", (w) => pendingExpense(w, "300"), "700.00", null],
        ["TRANSFER", (w, o) => pendingTransfer(w, o, "400"), "600.00", "1400.00"],
    ]) {
        test(`8 konfirmasi bersamaan pada ${label} yang sama: tepat 1 berhasil, tidak diproses ganda`, async () => {
            const wallet = await newWallet(userA, 1000);
            const other = await newWallet(userA, 1000);
            const transaction = await makePending(wallet, other);

            const results = await Promise.allSettled(
                Array.from({ length: 8 }, () => confirmTransaction(userA.id, transaction.id))
            );

            const fulfilled = results.filter((r) => r.status === "fulfilled");
            const rejected = results.filter((r) => r.status === "rejected");
            assert.equal(fulfilled.length, 1, rejected.map((r) => String(r.reason)).join(" | "));
            assert.equal(rejected.length, 7);
            for (const r of rejected) {
                assert.equal(r.reason.code, "TRANSACTION_NOT_PENDING");
                assert.deepEqual(r.reason.details, { status: "CONFIRMED" });
            }

            assert.equal(await balanceOf(wallet), expectedBalance);
            if (expectedOther) {
                assert.equal(await balanceOf(other), expectedOther);
            }
        });
    }

    test("5 pengeluaran Rp30 dikonfirmasi bersamaan dari saldo Rp100: tepat 3 lolos, saldo akhir 10, tidak pernah minus", async () => {
        const wallet = await newWallet(userA, 100);
        const expenses = [];
        for (let i = 0; i < 5; i++) {
            expenses.push(await pendingExpense(wallet, "30"));
        }

        const results = await Promise.allSettled(expenses.map((e) => confirmTransaction(userA.id, e.id)));
        const rejected = results.filter((r) => r.status === "rejected");

        assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
        assert.equal(rejected.length, 2);
        for (const r of rejected) {
            assert.equal(r.reason.code, "INSUFFICIENT_BALANCE");
        }

        assert.equal(await balanceOf(wallet), "10.00");
        assert.equal(await countByStatus([wallet.id], "CONFIRMED"), 3);
        assert.equal(await countByStatus([wallet.id], "PENDING"), 2);
    });

    test("campuran pengeluaran dan transfer keluar dari dompet yang sama: total keluar tidak melebihi saldo", async () => {
        const source = await newWallet(userA, 100);
        const destination = await newWallet(userA, 200);

        const pendings = [];
        for (let i = 0; i < 3; i++) {
            pendings.push({ kind: "expense", tx: await pendingExpense(source, "30") });
            pendings.push({ kind: "transfer", tx: await pendingTransfer(source, destination, "30") });
        }

        const results = await Promise.allSettled(pendings.map((p) => confirmTransaction(userA.id, p.tx.id)));
        const confirmedKinds = pendings.filter((_, i) => results[i].status === "fulfilled").map((p) => p.kind);
        const rejected = results.filter((r) => r.status === "rejected");

        assert.equal(confirmedKinds.length, 3, rejected.map((r) => String(r.reason)).join(" | "));
        for (const r of rejected) {
            assert.equal(r.reason.code, "INSUFFICIENT_BALANCE");
        }

        const confirmedTransfers = confirmedKinds.filter((k) => k === "transfer").length;
        assert.equal(await balanceOf(source), "10.00");
        assert.equal(await balanceOf(destination), (200 + 30 * confirmedTransfers).toFixed(2));
    });

    test("6 transfer A->B dan 6 transfer B->A dikonfirmasi bersamaan: semua selesai tanpa deadlock, saldo kembali sama", async () => {
        const a = await newWallet(userA, 1000);
        const b = await newWallet(userA, 1000);

        const pendings = [];
        for (let i = 0; i < 6; i++) {
            pendings.push(await pendingTransfer(a, b, "10"));
            pendings.push(await pendingTransfer(b, a, "10"));
        }

        const results = await Promise.allSettled(pendings.map((p) => confirmTransaction(userA.id, p.id)));
        const failures = results.filter((r) => r.status === "rejected");

        assert.equal(failures.length, 0, failures.map((r) => String(r.reason)).join(" | "));
        assert.equal(await balanceOf(a), "1000.00");
        assert.equal(await balanceOf(b), "1000.00");
        assert.equal(await countByStatus([a.id, b.id], "CONFIRMED"), 12);
    });

    test("konfirmasi pada dompet yang berbeda tidak saling menunggu", async () => {
        const w1 = await newWallet(userA, 1000);
        const w2 = await newWallet(userA, 1000);
        const t1 = await pendingExpense(w1, "10");
        const t2 = await pendingExpense(w2, "10");

        let release;
        const released = new Promise((resolve) => (release = resolve));
        let markLocked;
        const lockedSignal = new Promise((resolve) => (markLocked = resolve));

        const holder = runInTransaction(async (tx) => {
            await lockWallets(tx, userA.id, [w1.id]);
            markLocked();
            await released;
        });

        try {
            await lockedSignal;
            const started = Date.now();
            await confirmTransaction(userA.id, t2.id);
            assert.ok(Date.now() - started < 3000, "konfirmasi menunggu dompet yang tidak terlibat");
        } finally {
            release();
            await holder;
        }

        await confirmTransaction(userA.id, t1.id);
    });

    // Pengecekan-lalu-bertindak: saat transaksi lain sudah memakai saldo tetapi belum commit,
    // konfirmasi HARUS menunggu lalu memakai saldo terbaru. Tanpa penguncian, konfirmasi akan
    // membaca saldo lama (100) dan meloloskan pengeluaran yang membuat saldo minus.
    for (const kind of ["EXPENSE", "TRANSFER"]) {
        test(`konfirmasi ${kind} menunggu transaksi lain yang belum commit lalu memakai saldo terbaru`, async () => {
            const wallet = await newWallet(userA, 100);
            const other = await newWallet(userA, 0);
            const pending = kind === "EXPENSE" ? await pendingExpense(wallet, "30") : await pendingTransfer(wallet, other, "30");

            let release;
            const released = new Promise((resolve) => (release = resolve));
            let markLocked;
            const lockedSignal = new Promise((resolve) => (markLocked = resolve));

            // "Transaksi lain": mengunci dompet dan mencatat pengeluaran CONFIRMED Rp80, belum commit
            const holder = runInTransaction(async (tx) => {
                await lockWallets(tx, userA.id, [wallet.id]);
                await tx.transaction.create({
                    data: {
                        userId: userA.id,
                        walletId: wallet.id,
                        type: "EXPENSE",
                        amount: "80",
                        status: "CONFIRMED",
                        transactionDate: new Date(),
                    },
                });
                markLocked();
                await released;
            });

            let attempt;
            let settled = false;

            try {
                await lockedSignal;
                attempt = confirmTransaction(userA.id, pending.id).then(
                    (value) => {
                        settled = true;
                        return { value };
                    },
                    (error) => {
                        settled = true;
                        return { error };
                    }
                );

                await sleep(400);
                assert.equal(settled, false, "konfirmasi tidak menunggu penguncian dompet");
            } finally {
                release();
            }

            await holder;
            const outcome = await attempt;

            // Saldo terbaru = 100 - 80 = 20 < 30, jadi harus ditolak
            assert.ok(outcome.error, "konfirmasi seharusnya ditolak karena saldo terbaru tidak cukup");
            assert.equal(outcome.error.code, "INSUFFICIENT_BALANCE");
            assert.equal(outcome.error.details.available, "20.00");
            assert.equal(await statusOf(pending), "PENDING");
            assert.equal(await balanceOf(wallet), "20.00");
            assert.equal(await balanceOf(other), "0.00");
        });
    }
});
