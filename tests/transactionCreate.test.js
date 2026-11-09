// Pengujian Stage 2.2b: pembuatan transaksi INCOME dan EXPENSE.
// Jalankan dengan: npm test
// Tes membuat user, dompet, dan kategori SEMENTARA (nama diawali "__test_") lalu menghapusnya kembali.
// Data seed milik Anda tidak disentuh dan tidak dipakai.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/config/database.js";
import AppError from "../src/utils/AppError.js";
import { jsonReplacer } from "../src/utils/serialize.js";
import { getWalletBalance } from "../src/services/balanceService.js";
import { createIncome, createExpense } from "../src/services/transactionService.js";

let userA;
let userB;
let incomeCat; // kategori global INCOME
let expenseCat; // kategori global EXPENSE
let ownIncomeCat; // kategori INCOME milik user A
let ownExpenseCat; // kategori EXPENSE milik user A
let foreignIncomeCat; // kategori INCOME milik user B
const globalCategoryIds = [];

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_create_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_create_b__" } });

    const makeCategory = (userId, name, type) =>
        prisma.category.create({ data: { userId, name, type } });

    incomeCat = await makeCategory(null, "__test_global_income__", "INCOME");
    expenseCat = await makeCategory(null, "__test_global_expense__", "EXPENSE");
    globalCategoryIds.push(incomeCat.id, expenseCat.id);

    ownIncomeCat = await makeCategory(userA.id, "__test_own_income__", "INCOME");
    ownExpenseCat = await makeCategory(userA.id, "__test_own_expense__", "EXPENSE");
    foreignIncomeCat = await makeCategory(userB.id, "__test_foreign_income__", "INCOME");
});

after(async () => {
    const userIds = [userA.id, userB.id];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: { in: globalCategoryIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// ---------- helper ----------

const newWallet = (user, extra = {}) =>
    prisma.wallet.create({
        data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance: 1000, ...extra },
    });

const countTx = (walletId) => prisma.transaction.count({ where: { walletId } });

// Input valid untuk createIncome (default). Nilai bisa ditimpa per tes.
const validInput = (wallet, overrides = {}) => ({
    walletId: String(wallet.id),
    categoryId: String(incomeCat.id),
    amount: "25000.50",
    source: "WEB",
    ...overrides,
});

const expenseInput = (wallet, overrides = {}) =>
    validInput(wallet, { categoryId: String(expenseCat.id), ...overrides });

function rejectsWith(promise, statusCode, code) {
    return assert.rejects(promise, (err) => {
        assert.ok(err instanceof AppError, `bukan AppError: ${err?.stack ?? err}`);
        assert.equal(err.statusCode, statusCode, `status: ${err.statusCode} (${err.code})`);
        assert.equal(err.code, code);
        return true;
    });
}

// ---------- tes ----------

describe("pembuatan INCOME dan EXPENSE (jalur sukses)", () => {
    test("createIncome: tersimpan PENDING dengan nilai yang benar", async () => {
        const wallet = await newWallet(userA);
        const before = Date.now();
        const { transaction, created } = await createIncome(
            userA.id,
            validInput(wallet, { description: "Gaji bulan ini" })
        );

        assert.equal(created, true);
        assert.equal(transaction.type, "INCOME");
        assert.equal(transaction.status, "PENDING");
        assert.equal(transaction.userId, userA.id);
        assert.equal(transaction.walletId, wallet.id);
        assert.equal(transaction.categoryId, incomeCat.id);
        assert.equal(transaction.amount.toFixed(2), "25000.50");
        assert.equal(transaction.source, "WEB");
        assert.equal(transaction.description, "Gaji bulan ini");
        assert.equal(transaction.destinationWalletId, null);
        assert.equal(transaction.idempotencyKey, null);
        assert.equal(typeof transaction.id, "bigint");
        assert.ok(transaction.transactionDate.getTime() >= before - 1000);
        assert.ok(transaction.transactionDate.getTime() <= Date.now() + 1000);

        const inDb = await prisma.transaction.findUnique({ where: { id: transaction.id } });
        assert.equal(inDb.status, "PENDING");
        assert.equal(inDb.cancelledAt, null);
    });

    test("createExpense: tersimpan PENDING bertipe EXPENSE", async () => {
        const wallet = await newWallet(userA);
        const { transaction, created } = await createExpense(userA.id, expenseInput(wallet, { amount: 30000 }));

        assert.equal(created, true);
        assert.equal(transaction.type, "EXPENSE");
        assert.equal(transaction.status, "PENDING");
        assert.equal(transaction.amount.toFixed(2), "30000.00");
    });

    test("saldo TIDAK berubah setelah transaksi PENDING dibuat", async () => {
        const wallet = await newWallet(userA); // saldo awal 1000
        await createIncome(userA.id, validInput(wallet, { amount: "500" }));
        await createExpense(userA.id, expenseInput(wallet, { amount: "300" }));

        const { balance } = await getWalletBalance(prisma, userA.id, wallet.id);
        assert.equal(balance.toFixed(2), "1000.00");
    });

    test("EXPENSE lebih besar dari saldo tetap boleh dibuat sebagai PENDING (dicek saat konfirmasi)", async () => {
        const wallet = await newWallet(userA); // saldo 1000
        const { transaction } = await createExpense(userA.id, expenseInput(wallet, { amount: "999999" }));
        assert.equal(transaction.status, "PENDING");
    });

    test("kategori milik user sendiri dan kategori global sama-sama boleh", async () => {
        const wallet = await newWallet(userA);

        for (const [fn, category] of [
            [createIncome, ownIncomeCat],
            [createIncome, incomeCat],
            [createExpense, ownExpenseCat],
            [createExpense, expenseCat],
        ]) {
            const { transaction } = await fn(userA.id, validInput(wallet, { categoryId: String(category.id) }));
            assert.equal(transaction.categoryId, category.id);
        }
    });

    test("id boleh dikirim sebagai angka maupun string", async () => {
        const wallet = await newWallet(userA);
        const { transaction } = await createIncome(userA.id, {
            walletId: Number(wallet.id),
            categoryId: Number(incomeCat.id),
            amount: 10,
            source: "TELEGRAM",
        });
        assert.equal(transaction.walletId, wallet.id);
        assert.equal(transaction.source, "TELEGRAM");
    });

    test("userId diambil dari parameter, bukan dari input", async () => {
        const walletOfB = await newWallet(userB);
        // User A tidak bisa membuat transaksi di dompet milik B, apa pun isi input-nya
        await rejectsWith(createIncome(userA.id, validInput(walletOfB)), 404, "WALLET_NOT_FOUND");
        assert.equal(await countTx(walletOfB.id), 0);
    });

    test("hasil aman diserialisasi ke JSON (BigInt dan Decimal menjadi string)", async () => {
        const wallet = await newWallet(userA);
        const { transaction } = await createIncome(userA.id, validInput(wallet, { idempotencyKey: "serial-1" }));
        const json = JSON.parse(JSON.stringify({ success: true, data: transaction }, jsonReplacer));

        assert.equal(json.data.id, String(transaction.id));
        assert.equal(json.data.walletId, String(wallet.id));
        assert.equal(json.data.amount, "25000.50");
        assert.equal(json.data.idempotencyKey, "serial-1");
    });
});

describe("validasi input", () => {
    test("nominal tidak valid ditolak 400 dan tidak ada yang tersimpan", async () => {
        const wallet = await newWallet(userA);

        for (const bad of ["0", "0.00", "-5", "abc", "12.345", "", 0.1 + 0.2, {}, [], true]) {
            await rejectsWith(createIncome(userA.id, validInput(wallet, { amount: bad })), 400, "VALIDATION_ERROR");
        }
        assert.equal(await countTx(wallet.id), 0);
    });

    test("field wajib yang hilang atau null ditolak 400 dengan nama field-nya", async () => {
        const wallet = await newWallet(userA);

        for (const field of ["walletId", "categoryId", "amount", "source"]) {
            for (const emptyValue of [undefined, null]) {
                const input = validInput(wallet, { [field]: emptyValue });
                await assert.rejects(createIncome(userA.id, input), (err) => {
                    assert.equal(err.statusCode, 400);
                    assert.equal(err.details.field, field);
                    return true;
                });
            }
        }
        assert.equal(await countTx(wallet.id), 0);
    });

    test("id tidak valid ditolak 400", async () => {
        const wallet = await newWallet(userA);

        for (const bad of ["abc", "0", "-1", 1.5, "1.5", {}, "9223372036854775808"]) {
            await rejectsWith(createIncome(userA.id, validInput(wallet, { walletId: bad })), 400, "VALIDATION_ERROR");
            await rejectsWith(createIncome(userA.id, validInput(wallet, { categoryId: bad })), 400, "VALIDATION_ERROR");
        }
    });

    test("field tidak dikenal ditolak, termasuk status, userId, dan type", async () => {
        const wallet = await newWallet(userA);

        for (const extra of [
            { status: "CONFIRMED" },
            { userId: String(userB.id) },
            { type: "EXPENSE" },
            { destinationWalletId: "1" },
            { cancelledAt: "2026-11-09T00:00:00Z" },
            { foo: "bar" },
        ]) {
            await rejectsWith(createIncome(userA.id, validInput(wallet, extra)), 400, "VALIDATION_ERROR");
        }
        assert.equal(await countTx(wallet.id), 0);
    });

    test("input yang bukan objek ditolak 400", async () => {
        for (const bad of [null, undefined, "abc", 42, []]) {
            await rejectsWith(createIncome(userA.id, bad), 400, "VALIDATION_ERROR");
        }
    });

    test("source harus TELEGRAM, WEB, atau WHATSAPP (huruf besar persis)", async () => {
        const wallet = await newWallet(userA);

        for (const bad of ["telegram", "EMAIL", "", 1, {}]) {
            await rejectsWith(createIncome(userA.id, validInput(wallet, { source: bad })), 400, "VALIDATION_ERROR");
        }
        for (const ok of ["TELEGRAM", "WEB", "WHATSAPP"]) {
            const { transaction } = await createIncome(userA.id, validInput(wallet, { source: ok }));
            assert.equal(transaction.source, ok);
        }
    });

    test("description: di-trim, kosong menjadi null, maksimal 500 karakter, harus string", async () => {
        const wallet = await newWallet(userA);

        const trimmed = await createIncome(userA.id, validInput(wallet, { description: "  makan siang  " }));
        assert.equal(trimmed.transaction.description, "makan siang");

        for (const empty of ["   ", "", null]) {
            const { transaction } = await createIncome(userA.id, validInput(wallet, { description: empty }));
            assert.equal(transaction.description, null);
        }

        const atLimit = await createIncome(userA.id, validInput(wallet, { description: "x".repeat(500) }));
        assert.equal(atLimit.transaction.description.length, 500);

        await rejectsWith(createIncome(userA.id, validInput(wallet, { description: "x".repeat(501) })), 400, "VALIDATION_ERROR");
        await rejectsWith(createIncome(userA.id, validInput(wallet, { description: 123 })), 400, "VALIDATION_ERROR");
    });

    test("transactionDate: ISO 8601 dengan zona waktu diterima dan disimpan tepat", async () => {
        const wallet = await newWallet(userA);

        for (const text of ["2026-11-09T10:30:00+07:00", "2026-11-09T03:30:00Z", "2026-11-09T10:30+07:00", "2026-11-09T03:30:00.123Z"]) {
            const { transaction } = await createIncome(userA.id, validInput(wallet, { transactionDate: text }));
            assert.equal(transaction.transactionDate.getTime(), new Date(text).getTime(), text);
        }
    });

    test("transactionDate: format ambigu, tanggal mustahil, atau di luar rentang ditolak", async () => {
        const wallet = await newWallet(userA);

        for (const bad of [
            "2026-11-09", // tanpa jam dan zona waktu
            "2026-11-09T10:30:00", // tanpa zona waktu
            "2026-02-31T10:00:00Z", // 31 Februari tidak ada
            "2026-13-01T10:00:00Z", // bulan 13
            "2026-11-09T24:00:00Z", // jam 24
            "1999-12-31T23:59:59Z", // sebelum 2000
            "2100-01-01T00:00:00Z", // setelah 2099
            "kemarin",
            "",
            123,
            {},
        ]) {
            await rejectsWith(
                createIncome(userA.id, validInput(wallet, { transactionDate: bad })),
                400,
                "VALIDATION_ERROR"
            );
        }
        assert.equal(await countTx(wallet.id), 0);
    });
});

describe("validasi kepemilikan wallet dan category", () => {
    test("dompet milik user lain atau yang tidak ada: 404 yang sama, tidak ada yang tersimpan", async () => {
        const walletOfB = await newWallet(userB);

        for (const walletId of [String(walletOfB.id), "999999999"]) {
            await rejectsWith(createIncome(userA.id, validInput(walletOfB, { walletId })), 404, "WALLET_NOT_FOUND");
            await rejectsWith(createExpense(userA.id, expenseInput(walletOfB, { walletId })), 404, "WALLET_NOT_FOUND");
        }
        assert.equal(await countTx(walletOfB.id), 0);
    });

    test("dompet nonaktif ditolak 422", async () => {
        const inactive = await newWallet(userA, { isActive: false });

        await rejectsWith(createIncome(userA.id, validInput(inactive)), 422, "WALLET_INACTIVE");
        await rejectsWith(createExpense(userA.id, expenseInput(inactive)), 422, "WALLET_INACTIVE");
        assert.equal(await countTx(inactive.id), 0);
    });

    test("kategori milik user lain atau yang tidak ada: 404 yang sama, tidak ada yang tersimpan", async () => {
        const wallet = await newWallet(userA);

        for (const categoryId of [String(foreignIncomeCat.id), "999999999"]) {
            await rejectsWith(createIncome(userA.id, validInput(wallet, { categoryId })), 404, "CATEGORY_NOT_FOUND");
        }
        assert.equal(await countTx(wallet.id), 0);
    });

    test("tipe kategori harus sama dengan tipe transaksi (kedua arah)", async () => {
        const wallet = await newWallet(userA);

        await rejectsWith(
            createIncome(userA.id, validInput(wallet, { categoryId: String(expenseCat.id) })),
            422,
            "CATEGORY_TYPE_MISMATCH"
        );
        await rejectsWith(
            createExpense(userA.id, validInput(wallet, { categoryId: String(incomeCat.id) })),
            422,
            "CATEGORY_TYPE_MISMATCH"
        );
        await rejectsWith(
            createExpense(userA.id, validInput(wallet, { categoryId: String(ownIncomeCat.id) })),
            422,
            "CATEGORY_TYPE_MISMATCH"
        );
        assert.equal(await countTx(wallet.id), 0);
    });
});

describe("idempotency {userId}:{key}", () => {
    test("kunci disimpan sebagai '{userId}:{key}' tetapi dikembalikan tanpa awalan", async () => {
        const wallet = await newWallet(userA);
        const { transaction } = await createIncome(userA.id, validInput(wallet, { idempotencyKey: "tg:1:100" }));

        assert.equal(transaction.idempotencyKey, "tg:1:100");

        const inDb = await prisma.transaction.findUnique({ where: { id: transaction.id } });
        assert.equal(inDb.idempotencyKey, `${userA.id}:tg:1:100`);
    });

    test("permintaan ulang dengan kunci dan isi sama mengembalikan transaksi yang sama (tanpa duplikat)", async () => {
        const wallet = await newWallet(userA);
        const input = validInput(wallet, { idempotencyKey: "retry-1", description: "kopi" });

        const first = await createIncome(userA.id, input);
        const second = await createIncome(userA.id, input);
        const third = await createIncome(userA.id, { ...input });

        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(third.created, false);
        assert.equal(second.transaction.id, first.transaction.id);
        assert.equal(third.transaction.id, first.transaction.id);
        assert.equal(await countTx(wallet.id), 1);
    });

    test("kunci sama dengan isi berbeda ditolak 409 (nominal, dompet, kategori, tipe, deskripsi, source)", async () => {
        const wallet = await newWallet(userA);
        const otherWallet = await newWallet(userA);
        const input = validInput(wallet, { idempotencyKey: "conflict-1", description: "asli" });
        const first = await createIncome(userA.id, input);

        const variants = [
            () => createIncome(userA.id, { ...input, amount: "25000.51" }),
            () => createIncome(userA.id, { ...input, walletId: String(otherWallet.id) }),
            () => createIncome(userA.id, { ...input, categoryId: String(ownIncomeCat.id) }),
            () => createIncome(userA.id, { ...input, description: "beda" }),
            () => createIncome(userA.id, { ...input, description: undefined }),
            () => createIncome(userA.id, { ...input, source: "TELEGRAM" }),
            () => createExpense(userA.id, { ...input, categoryId: String(expenseCat.id) }), // tipe berbeda
        ];

        for (const attempt of variants) {
            await rejectsWith(attempt(), 409, "IDEMPOTENCY_CONFLICT");
        }

        assert.equal(await countTx(wallet.id), 1);
        assert.equal(await countTx(otherWallet.id), 0);
        const stillThere = await prisma.transaction.findUnique({ where: { id: first.transaction.id } });
        assert.equal(stillThere.amount.toFixed(2), "25000.50");
    });

    test("nominal yang sama ditulis berbeda ('25000.5' dan 25000.50) dianggap isi yang sama", async () => {
        const wallet = await newWallet(userA);
        const first = await createIncome(userA.id, validInput(wallet, { amount: "25000.50", idempotencyKey: "amount-fmt" }));
        const second = await createIncome(userA.id, validInput(wallet, { amount: 25000.5, idempotencyKey: "amount-fmt" }));

        assert.equal(second.created, false);
        assert.equal(second.transaction.id, first.transaction.id);
    });

    test("transactionDate ikut dibandingkan hanya jika dikirim pada permintaan ulang", async () => {
        const wallet = await newWallet(userA);
        const date = "2026-11-09T10:30:00+07:00";
        const first = await createIncome(userA.id, validInput(wallet, { idempotencyKey: "date-1", transactionDate: date }));

        const same = await createIncome(userA.id, validInput(wallet, { idempotencyKey: "date-1", transactionDate: date }));
        assert.equal(same.created, false);

        const omitted = await createIncome(userA.id, validInput(wallet, { idempotencyKey: "date-1" }));
        assert.equal(omitted.created, false);
        assert.equal(omitted.transaction.id, first.transaction.id);

        await rejectsWith(
            createIncome(userA.id, validInput(wallet, { idempotencyKey: "date-1", transactionDate: "2026-11-10T10:30:00+07:00" })),
            409,
            "IDEMPOTENCY_CONFLICT"
        );
    });

    test("tanpa tanggal pada kedua permintaan: tidak bentrok meskipun waktu 'sekarang' berbeda", async () => {
        const wallet = await newWallet(userA);
        const first = await createIncome(userA.id, validInput(wallet, { idempotencyKey: "nodate-1" }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const second = await createIncome(userA.id, validInput(wallet, { idempotencyKey: "nodate-1" }));

        assert.equal(second.created, false);
        assert.equal(second.transaction.id, first.transaction.id);
    });

    test("kunci yang sama dari dua user berbeda tidak bertabrakan dan tidak saling melihat", async () => {
        const walletA = await newWallet(userA);
        const walletB = await newWallet(userB);

        const a = await createIncome(userA.id, validInput(walletA, { idempotencyKey: "shared-key" }));
        const b = await createIncome(userB.id, validInput(walletB, { idempotencyKey: "shared-key", categoryId: String(foreignIncomeCat.id) }));

        assert.equal(a.created, true);
        assert.equal(b.created, true);
        assert.notEqual(a.transaction.id, b.transaction.id);
        assert.equal(a.transaction.userId, userA.id);
        assert.equal(b.transaction.userId, userB.id);

        // User B mengulang dengan data yang bukan miliknya: tidak membocorkan transaksi user A
        const retryB = await createIncome(userB.id, validInput(walletB, { idempotencyKey: "shared-key", categoryId: String(foreignIncomeCat.id) }));
        assert.equal(retryB.transaction.id, b.transaction.id);
    });

    test("tanpa kunci: dua permintaan identik membuat dua transaksi (tidak ada deduplikasi)", async () => {
        const wallet = await newWallet(userA);
        const first = await createIncome(userA.id, validInput(wallet));
        const second = await createIncome(userA.id, validInput(wallet));

        assert.equal(first.created, true);
        assert.equal(second.created, true);
        assert.notEqual(first.transaction.id, second.transaction.id);
        assert.equal(await countTx(wallet.id), 2);
    });

    test("kunci berbeda untuk isi yang sama membuat transaksi terpisah", async () => {
        const wallet = await newWallet(userA);
        await createIncome(userA.id, validInput(wallet, { idempotencyKey: "k-1" }));
        await createIncome(userA.id, validInput(wallet, { idempotencyKey: "k-2" }));

        assert.equal(await countTx(wallet.id), 2);
    });

    test("format kunci: ditolak jika kosong, mengandung spasi/simbol lain, atau lebih dari 100 karakter", async () => {
        const wallet = await newWallet(userA);

        for (const bad of ["", " abc", "a b", "a/b", "kunci😀", "a".repeat(101), 123, {}]) {
            await rejectsWith(createIncome(userA.id, validInput(wallet, { idempotencyKey: bad })), 400, "VALIDATION_ERROR");
        }
        assert.equal(await countTx(wallet.id), 0);

        // Tepat 100 karakter diterima dan tetap muat di kolom (userId + ':' + 100 <= 150)
        const longKey = "k".repeat(100);
        const { transaction } = await createIncome(userA.id, validInput(wallet, { idempotencyKey: longKey }));
        assert.equal(transaction.idempotencyKey, longKey);
    });

    test("replay mengembalikan status terkini, termasuk setelah transaksi dibatalkan", async () => {
        const wallet = await newWallet(userA);
        const input = validInput(wallet, { idempotencyKey: "status-1" });
        const first = await createIncome(userA.id, input);

        await prisma.transaction.update({
            where: { id: first.transaction.id },
            data: { status: "CANCELLED", cancelledAt: new Date() },
        });

        const replayed = await createIncome(userA.id, input);
        assert.equal(replayed.created, false);
        assert.equal(replayed.transaction.status, "CANCELLED");
        assert.equal(await countTx(wallet.id), 1);
    });

    test("balapan: 8 permintaan bersamaan dengan kunci dan isi sama -> tepat 1 transaksi", async () => {
        const wallet = await newWallet(userA);
        const input = validInput(wallet, { idempotencyKey: "race-1" });

        const results = await Promise.allSettled(Array.from({ length: 8 }, () => createIncome(userA.id, input)));

        assert.equal(results.filter((r) => r.status === "rejected").length, 0, JSON.stringify(results.filter((r) => r.status === "rejected").map((r) => String(r.reason))));
        const values = results.map((r) => r.value);
        assert.equal(values.filter((v) => v.created).length, 1);
        assert.equal(new Set(values.map((v) => v.transaction.id)).size, 1);
        assert.equal(await countTx(wallet.id), 1);
    });

    test("balapan lintas dompet: kunci sama, dompet berbeda -> tepat 1 berhasil, 1 ditolak 409", async () => {
        const walletOne = await newWallet(userA);
        const walletTwo = await newWallet(userA);

        const results = await Promise.allSettled([
            createIncome(userA.id, validInput(walletOne, { idempotencyKey: "race-2" })),
            createIncome(userA.id, validInput(walletTwo, { idempotencyKey: "race-2" })),
        ]);

        const ok = results.filter((r) => r.status === "fulfilled");
        const failed = results.filter((r) => r.status === "rejected");
        assert.equal(ok.length, 1);
        assert.equal(failed.length, 1);
        assert.equal(failed[0].reason.code, "IDEMPOTENCY_CONFLICT");
        assert.equal((await countTx(walletOne.id)) + (await countTx(walletTwo.id)), 1);
    });
});
